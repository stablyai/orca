// U5: resume/fork ingestion resolves the private record by ownership key and
// produces the resume-specific launch inputs (v1-snapshot replay or opaque legacy
// replay), or an in-band invalid_launch_snapshot that never silently substitutes
// current config.
import { describe, expect, it } from 'vitest'
import type { AgentLaunchSnapshot } from '../../shared/agent-launch-host-contract'
import type {
  AgentSessionOwnershipKey,
  SleepingAgentLaunchConfig
} from '../../shared/agent-session-resume'
import { AgentSessionRecordStore } from './agent-session-record-store'
import {
  resolveResumeLaunchIngest,
  type ResumeLaunchIngestInput
} from './agent-launch-resume-ingest'

function snapshot(): AgentLaunchSnapshot {
  return {
    version: 1,
    requestedAgent: 'custom-agent:claude:reviewer',
    baseAgent: 'claude',
    displayLabel: 'Reviewer',
    mode: 'custom',
    argv: ['claude'],
    agentEnv: {},
    capturedEnvPolicy: 'none',
    target: {
      platform: 'darwin',
      execution: 'native',
      shell: 'posix',
      isRemote: false,
      executionHostId: 'local'
    }
  }
}

const KEY: AgentSessionOwnershipKey = {
  worktreeId: 'wt-1',
  baseAgent: 'claude',
  providerSessionId: 'sess-1'
}

// Real captured shape: `agentCommand` is the COMPLETE pre-quoted base command
// (args already embedded by buildSleepingAgentLaunchConfig); `agentArgs` is the
// raw echo of the same flags, which the replay must not re-append.
const LEGACY_CONFIG: SleepingAgentLaunchConfig = {
  agentCommand: "claude '--model' 'opus'",
  agentArgs: '--model opus',
  agentEnv: { FOO: 'bar' }
}

/** Desktop trusted context with an optional first-resume handoff. */
function desktopLegacy(
  handoff?: {
    launchConfig: SleepingAgentLaunchConfig
    recordedConnectionId: string | null
    transcriptPath?: string
  },
  connectionId: string | null = null
): ResumeLaunchIngestInput['legacy'] {
  return { shell: 'posix', connectionId, ...(handoff ? { handoff } : {}) }
}

function storeWithBoundRecord(): AgentSessionRecordStore {
  const store = new AgentSessionRecordStore()
  store.register({
    paneKey: 'pane-a',
    terminalId: 'term-a',
    worktreeId: 'wt-1',
    requestedAgent: 'custom-agent:claude:reviewer',
    baseAgent: 'claude',
    launchSnapshot: snapshot(),
    launchToken: 'token-a'
  })
  store.bindProviderSessionByToken('token-a', { key: 'session_id', id: 'sess-1' })
  return store
}

describe('resolveResumeLaunchIngest — v1 snapshot', () => {
  it('produces resume inputs from a bound v1-snapshot record', () => {
    const result = resolveResumeLaunchIngest(
      { resume: { operation: 'resume', sessionKey: KEY }, client: 'desktop' },
      storeWithBoundRecord()
    )
    expect(result.ok && result.kind).toBe('snapshot')
    if (!result.ok || result.kind !== 'snapshot') {
      return
    }
    expect(result.request.selection).toEqual({
      kind: 'agent',
      agent: 'custom-agent:claude:reviewer'
    })
    expect(result.request.sourceRecord).toEqual({ owner: 'session' })
    expect(result.request.allowEmptyPromptLaunch).toBe(true)
    expect(result.request.prompt).toBeUndefined()
    expect(result.intent).toEqual({ kind: 'resume', operation: 'resume', client: 'desktop' })
    expect(result.persistedSnapshot).toEqual(snapshot())
    expect(result.resumeProviderSession).toEqual({ key: 'session_id', id: 'sess-1' })
  })

  it('carries the fork operation into the intent', () => {
    const result = resolveResumeLaunchIngest(
      { resume: { operation: 'fork', sessionKey: KEY }, client: 'desktop' },
      storeWithBoundRecord()
    )
    expect(result.ok && result.intent).toMatchObject({ kind: 'resume', operation: 'fork' })
  })

  it('maps the authenticated client into the resume intent', () => {
    const result = resolveResumeLaunchIngest(
      { resume: { operation: 'resume', sessionKey: KEY }, client: 'mobile' },
      storeWithBoundRecord()
    )
    expect(result.ok && result.intent).toMatchObject({ client: 'mobile' })
  })

  it('returns invalid_launch_snapshot for an unknown ownership key', () => {
    const result = resolveResumeLaunchIngest(
      {
        resume: {
          operation: 'resume',
          sessionKey: { worktreeId: 'wt-x', baseAgent: 'codex', providerSessionId: 'nope' }
        },
        client: 'desktop'
      },
      storeWithBoundRecord()
    )
    expect(result).toEqual({ ok: false, failure: { code: 'invalid_launch_snapshot' } })
  })
})

describe('resolveResumeLaunchIngest — opaque legacy replay', () => {
  it('persists the surrendered config once and replays it opaquely on first resume', () => {
    const store = new AgentSessionRecordStore()
    const result = resolveResumeLaunchIngest(
      {
        resume: { operation: 'resume', sessionKey: KEY },
        client: 'desktop',
        legacy: desktopLegacy({ launchConfig: LEGACY_CONFIG, recordedConnectionId: null })
      },
      store
    )
    expect(result.ok && result.kind).toBe('legacy')
    if (!result.ok || result.kind !== 'legacy') {
      return
    }
    expect(result.baseAgent).toBe('claude')
    expect(result.requestedAgent).toBe('claude')
    // The captured base command (args already inside it), then the appended
    // provider resume flags (one-shot only) — each exactly once.
    expect(result.launchCommand).toBe("claude '--model' 'opus' '--resume' 'sess-1'")
    expect(result.launchCommand).toContain('claude')
    expect(result.launchCommand).toContain('--model')
    expect(result.launchCommand).toContain('--resume')
    expect(result.launchCommand).toContain('sess-1')
    // Durable config stays base-only so a fresh relaunch never re-resumes.
    expect(result.launchConfig.agentArgs).toBe('--model opus')
    expect(result.launchConfig.agentArgs).not.toContain('--resume')
    // Persist-once: the host now owns the record and a second resume needs no handoff.
    const stored = store.resolveByOwnershipKey(KEY)
    expect(stored?.legacyLaunchConfig).toEqual(LEGACY_CONFIG)
    const second = resolveResumeLaunchIngest(
      {
        resume: { operation: 'resume', sessionKey: KEY },
        client: 'desktop',
        legacy: desktopLegacy()
      },
      store
    )
    expect(second.ok && second.kind).toBe('legacy')
  })

  it('carries the handoff transcript path so a pre-upgrade Pi session still resumes', () => {
    // Regression: Pi/Prime-Agent resume by transcript path, but the ownership key
    // carries only the session id. Dropping the handoff's path made every
    // pre-upgrade sleeping Pi/Prime session fail closed on first resume.
    const piKey: AgentSessionOwnershipKey = {
      worktreeId: 'wt-1',
      baseAgent: 'pi',
      providerSessionId: 'sess-pi'
    }
    const store = new AgentSessionRecordStore()
    const result = resolveResumeLaunchIngest(
      {
        resume: { operation: 'resume', sessionKey: piKey },
        client: 'desktop',
        legacy: desktopLegacy({
          launchConfig: { agentCommand: 'pi', agentArgs: '', agentEnv: {} },
          recordedConnectionId: null,
          transcriptPath: '/home/me/.pi/sessions/sess-pi.jsonl'
        })
      },
      store
    )
    expect(result.ok && result.kind).toBe('legacy')
    if (!result.ok || result.kind !== 'legacy') {
      return
    }
    expect(result.launchCommand).toContain('--session')
    expect(result.launchCommand).toContain('/home/me/.pi/sessions/sess-pi.jsonl')
    // The host owns the path thereafter, so a later resume needs no handoff.
    expect(store.resolveByOwnershipKey(piKey)?.providerSession.transcriptPath).toBe(
      '/home/me/.pi/sessions/sess-pi.jsonl'
    )
    const second = resolveResumeLaunchIngest(
      {
        resume: { operation: 'resume', sessionKey: piKey },
        client: 'desktop',
        legacy: desktopLegacy()
      },
      store
    )
    expect(second.ok && second.kind).toBe('legacy')
  })

  it('fails closed when a Pi handoff has no transcript path to resume by', () => {
    const store = new AgentSessionRecordStore()
    const result = resolveResumeLaunchIngest(
      {
        resume: {
          operation: 'resume',
          sessionKey: { worktreeId: 'wt-1', baseAgent: 'pi', providerSessionId: 'sess-pi' }
        },
        client: 'desktop',
        legacy: desktopLegacy({
          launchConfig: { agentCommand: 'pi', agentArgs: '', agentEnv: {} },
          recordedConnectionId: null
        })
      },
      store
    )
    // Never a partial write: an unresumable handoff leaves the store untouched.
    expect(result.ok).toBe(false)
    expect(
      store.resolveByOwnershipKey({
        worktreeId: 'wt-1',
        baseAgent: 'pi',
        providerSessionId: 'sess-pi'
      })
    ).toBeNull()
  })

  it('strips Orca attribution env before replay and persists the cleaned config', () => {
    const store = new AgentSessionRecordStore()
    const result = resolveResumeLaunchIngest(
      {
        resume: { operation: 'resume', sessionKey: KEY },
        client: 'desktop',
        legacy: desktopLegacy({
          launchConfig: {
            agentCommand: ' claude ',
            agentArgs: '  ',
            agentEnv: { FOO: 'bar', ORCA_PANE_KEY: 'pane', TMUX: 'x' }
          },
          recordedConnectionId: null
        })
      },
      store
    )
    expect(result.ok && result.kind === 'legacy' && result.launchConfig.agentEnv).toEqual({
      FOO: 'bar'
    })
    // The durable record holds the replay's cleaned config, never the raw handoff.
    expect(store.resolveByOwnershipKey(KEY)?.legacyLaunchConfig).toEqual({
      agentCommand: 'claude',
      agentArgs: '',
      agentEnv: { FOO: 'bar' }
    })
  })

  it('fails closed when the recorded execution owner no longer matches', () => {
    const store = new AgentSessionRecordStore()
    const result = resolveResumeLaunchIngest(
      {
        resume: { operation: 'resume', sessionKey: KEY },
        client: 'desktop',
        legacy: desktopLegacy(
          { launchConfig: LEGACY_CONFIG, recordedConnectionId: 'ssh:old' },
          'ssh:new'
        )
      },
      store
    )
    expect(result).toEqual({ ok: false, failure: { code: 'invalid_launch_snapshot' } })
    // Never a partial write: an owner mismatch leaves the store untouched.
    expect(store.resolveByOwnershipKey(KEY)).toBeNull()
  })

  it('fails closed on an invalid surviving env and never writes the record', () => {
    const store = new AgentSessionRecordStore()
    const result = resolveResumeLaunchIngest(
      {
        resume: { operation: 'resume', sessionKey: KEY },
        client: 'desktop',
        legacy: desktopLegacy({
          launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: { BAD: 'a\u0000b' } },
          recordedConnectionId: null
        })
      },
      store
    )
    expect(result).toEqual({ ok: false, failure: { code: 'invalid_launch_snapshot' } })
    expect(store.resolveByOwnershipKey(KEY)).toBeNull()
  })

  it('never opaque-replays a stored legacy record for a non-desktop client', () => {
    const store = new AgentSessionRecordStore()
    store.ingestLegacyRecord({
      ownershipKey: KEY,
      requestedAgent: 'claude',
      providerSession: { key: 'session_id', id: 'sess-1' },
      legacyLaunchConfig: LEGACY_CONFIG,
      connectionId: null
    })
    // Mobile/paired never carry the trusted legacy context, so the record fails
    // closed to "Launch with current settings".
    const result = resolveResumeLaunchIngest(
      { resume: { operation: 'resume', sessionKey: KEY }, client: 'mobile' },
      store
    )
    expect(result).toEqual({ ok: false, failure: { code: 'invalid_launch_snapshot' } })
  })

  it('returns invalid_launch_snapshot for a legacy record with no v1 snapshot when no trusted context', () => {
    const store = new AgentSessionRecordStore()
    store.ingestLegacyRecord({
      ownershipKey: KEY,
      requestedAgent: 'claude',
      providerSession: { key: 'session_id', id: 'sess-1' },
      legacyLaunchConfig: LEGACY_CONFIG,
      connectionId: null
    })
    const result = resolveResumeLaunchIngest(
      { resume: { operation: 'resume', sessionKey: KEY }, client: 'desktop' },
      store
    )
    expect(result).toEqual({ ok: false, failure: { code: 'invalid_launch_snapshot' } })
  })
})
