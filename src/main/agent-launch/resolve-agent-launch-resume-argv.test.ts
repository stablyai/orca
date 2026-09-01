// U5: a resume/fork replay appends the provider resume flags to the immutable
// snapshot argv (from the record's session, never the snapshot), and builds the
// launch command from base + resume flags while the durable launch config keeps
// only the base command so a fresh relaunch never re-resumes a stale session.
import { describe, expect, it } from 'vitest'
import type {
  AgentLaunchSnapshot,
  ResolvedAgentLaunch
} from '../../shared/agent-launch-host-contract'
import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'
import { buildAgentStartupPlanFromResolvedLaunch } from '../../shared/resolved-agent-startup-plan'
import { resolveAgentLaunch, type ResolveAgentLaunchOutcome } from './resolve-agent-launch'
import { catalogOf, requestOf, settingsOf } from './agent-launch-test-catalog'

function snapshotOf(overrides: Partial<AgentLaunchSnapshot> = {}): AgentLaunchSnapshot {
  return {
    version: 1,
    requestedAgent: 'claude',
    baseAgent: 'claude',
    displayLabel: 'Claude',
    mode: 'built-in',
    argv: ['claude'],
    agentEnv: {},
    capturedEnvPolicy: 'none',
    target: {
      platform: 'darwin',
      execution: 'native',
      shell: 'posix',
      isRemote: false,
      executionHostId: 'local'
    },
    ...overrides
  }
}

function replay(
  snapshot: AgentLaunchSnapshot,
  resumeProviderSession: AgentProviderSessionMetadata
): ResolveAgentLaunchOutcome {
  return resolveAgentLaunch(
    requestOf({
      selection: { kind: 'agent', agent: snapshot.requestedAgent },
      intent: { kind: 'resume', operation: 'resume', client: 'desktop' },
      reference: { kind: 'persisted', owner: 'session' },
      platform: 'darwin',
      shell: 'posix',
      persistedSnapshot: snapshot,
      resumeProviderSession
    }),
    catalogOf({}),
    settingsOf()
  )
}

function launchOf(outcome: ResolveAgentLaunchOutcome): ResolvedAgentLaunch {
  if (!outcome.ok) {
    throw new Error(`expected launch, got ${JSON.stringify(outcome)}`)
  }
  return outcome.launch
}

describe('resume-argv replay', () => {
  it('preserves custom Codex argv and appends the record resume id exactly once', () => {
    const launch = launchOf(
      replay(
        snapshotOf({
          requestedAgent: 'custom-agent:codex:sol',
          baseAgent: 'codex',
          displayLabel: 'Codex Sol',
          mode: 'custom',
          argv: ['codex', '--model', 'gpt-5.6-Sol', '-c', 'model_reasoning_effort=medium']
        }),
        { key: 'session_id', id: 'record-resume-id' }
      )
    )
    expect(launch.argv).toEqual([
      'codex',
      '--model',
      'gpt-5.6-Sol',
      '-c',
      'model_reasoning_effort=medium'
    ])
    expect(launch.resumeArgvSuffix).toEqual(['resume', 'record-resume-id'])
    const plan = buildAgentStartupPlanFromResolvedLaunch({
      launch,
      prompt: '',
      allowEmptyPromptLaunch: true
    })
    expect(plan?.launchCommand).toContain("'--model' 'gpt-5.6-Sol'")
    expect(plan?.launchCommand.split('record-resume-id')).toHaveLength(2)
  })

  it('appends the claude resume flags to the command but not the snapshot argv', () => {
    const launch = launchOf(replay(snapshotOf(), { key: 'session_id', id: 'sess-9' }))
    // The immutable snapshot argv is unchanged; the resume flags ride a suffix.
    expect(launch.argv).toEqual(['claude'])
    expect(launch.resumeArgvSuffix).toEqual(['--resume', 'sess-9'])

    const plan = buildAgentStartupPlanFromResolvedLaunch({
      launch,
      prompt: '',
      allowEmptyPromptLaunch: true
    })
    expect(plan?.launchCommand).toContain('--resume')
    expect(plan?.launchCommand).toContain('sess-9')
    // The durable config keeps only the base command — no resume flags leak in.
    expect(plan?.launchConfig.agentCommand).toContain('claude')
    expect(plan?.launchConfig.agentCommand).not.toContain('--resume')
    expect(plan?.launchConfig.agentCommand).not.toContain('sess-9')
  })

  it('uses the antigravity conversation flag for a conversation-keyed session', () => {
    const snapshot = snapshotOf({
      requestedAgent: 'antigravity',
      baseAgent: 'antigravity',
      argv: ['agy']
    })
    const launch = launchOf(replay(snapshot, { key: 'conversation_id', id: 'conv-1' }))
    expect(launch.resumeArgvSuffix).toEqual(['--conversation', 'conv-1'])
  })

  it('invalidates when the session key type does not match the base', () => {
    // Claude resumes by session_id; a conversation_id session cannot form a valid
    // resume command, so the replay fails closed rather than launching fresh.
    const outcome = replay(snapshotOf(), { key: 'conversation_id', id: 'conv-1' })
    expect(outcome.ok).toBe(false)
    expect(!outcome.ok && 'failure' in outcome && outcome.failure.code).toBe(
      'invalid_launch_snapshot'
    )
  })

  it('replays without a resume suffix when no provider session is supplied', () => {
    const outcome = resolveAgentLaunch(
      requestOf({
        selection: { kind: 'agent', agent: 'claude' },
        intent: { kind: 'resume', operation: 'resume', client: 'desktop' },
        reference: { kind: 'persisted', owner: 'session' },
        platform: 'darwin',
        shell: 'posix',
        persistedSnapshot: snapshotOf()
      }),
      catalogOf({}),
      settingsOf()
    )
    expect(launchOf(outcome).resumeArgvSuffix).toBeUndefined()
  })
})
