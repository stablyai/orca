import { createAcpStructuredLaunchResolver } from '../runtime/agent-session/launch/structured-agent-launch-composition.test-support'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import { agentSessionProviderHandleKey } from '../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import type { AgentSessionProviderHandle } from '../../shared/agent-session/lifecycle/agent-session-provider-handle'
import type { AgentSessionRecord } from '../../shared/agent-session/lifecycle/agent-session-record'
import { agentSessionRecordFixture } from '../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import { agentJournalTurnBody } from '../../shared/agent-session/lifecycle/agent-session-turn-record'
import { createTrackedJournalOpener } from '../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { journalSqlReads } from '../native-chat/agent-session-journal/journal-sql-reads'
import { openTestAgentSessionDatabase } from '../runtime/agent-session/records/agent-session-record-store-test-harness'
import {
  createLegacyProviderTimelineIdentityScheme,
  spellProviderTimelineKey
} from '../native-chat/agent-session-timeline/provider-timeline-identity'
import { acpLaunchSpecFor } from './acp-launch-specs'
import type { AcpSavedSessionReads } from './acp-structured-resume-history'

const GROK = acpLaunchSpecFor('grok')!
const OMP = acpLaunchSpecFor('omp')!
const identity = {
  sessionId: 'session-alpha-1',
  workspaceId: 'workspace-1',
  hostId: 'local',
  agent: 'grok',
  providerHandle: null
}

function grokRecord(overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  return {
    ...agentSessionRecordFixture(),
    provider: 'grok',
    providerHandleChain: [],
    accountHome: { variable: 'GROK_HOME', path: '/home/user/.grok-work' },
    ...overrides
  }
}

function ompRecord(options: Record<string, string>, resumes: boolean): AgentSessionRecord {
  return grokRecord({
    provider: 'omp',
    accountHome: { variable: 'PI_CODING_AGENT_DIR', path: '/home/user/.omp/agent' },
    options,
    providerHandleChain: resumes
      ? [
          {
            linkId: 'link-created',
            origin: 'created',
            mintedAtFence: 1,
            observedAt: 1,
            handle: { transport: 'acp', agent: 'omp', nativeId: 'omp-1' }
          }
        ]
      : []
  })
}

const NOTHING_SAVED: AcpSavedSessionReads = {
  hasProviderTurn: async () => false
}

function resolver(record: AgentSessionRecord, savedSession = NOTHING_SAVED, spec = GROK) {
  const searched: (string | null | undefined)[] = []
  return {
    searched,
    resolve: createAcpStructuredLaunchResolver(spec, {
      store: { getRecord: () => record, pinLaunchDirectory: vi.fn() },
      savedSession,
      resolveWorkspacePath: async () => '/repo/worktree',
      resolveEnvironment: async () => ({ PATH: '/usr/bin', HOME: '/home/user' }),
      resolveLaunchEnv: () => ({ GROK_EXTRA: '1' }),
      resolveCommand: (command, options) => {
        searched.push(options?.pathEnv)
        return `/resolved/${command}`
      }
    })
  }
}

describe('ACP launch resolution', () => {
  it('resumes a saved exchange and carries loss candidates independently of journal readability', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-acp-saved-read-'))
    const journals = createTrackedJournalOpener()
    try {
      const handle: AgentSessionProviderHandle = {
        transport: 'acp',
        agent: 'grok',
        nativeId: 'acp-1'
      }
      const lostKey = agentSessionProviderHandleKey({ ...handle, nativeId: 'acp-lost' })
      const record = grokRecord({
        providerHandleChain: [
          {
            linkId: 'head',
            origin: 'created',
            mintedAtFence: 1,
            observedAt: 1,
            handle,
            replaces: { key: lostKey, reason: 'restore-failed', replacedAt: 1 }
          }
        ]
      })
      const journal = await journals.open({ stateDirectory: root, identity, now: () => 1 })
      const { readers } = await openTestAgentSessionDatabase(root)
      const savedSession: AcpSavedSessionReads = {
        hasProviderTurn: (sessionId, nativeId) =>
          journalSqlReads(readers, sessionId).hasProviderTurn(nativeId)
      }
      const readDecisions = async (saved: AcpSavedSessionReads) => {
        const launch = await resolver(record, saved).resolve({ identity })
        return {
          unsaved: await launch.resume?.mayBeUnsaved(),
          losses: launch.resume?.lossKeys
        }
      }
      // Nothing saved on acp-1 yet, so the created session may hold an unsaved exchange.
      expect(await readDecisions(savedSession)).toEqual({ unsaved: true, losses: [lostKey] })
      const turnId = spellProviderTimelineKey('acp-1', { source: 'provider', value: 'prompt:m0' })
      await journal.appendItem(
        createLegacyProviderTimelineIdentityScheme({
          agent: 'grok',
          sessionId: identity.sessionId
        }).item({
          namespace: 'acp-1',
          family: 'item',
          key: { source: 'provider', value: 'turn' },
          thread: 'acp-1'
        }),
        agentJournalTurnBody({ turnId, state: 'completed', startedAt: 1 }),
        { fence: 1, turnScope: { kind: 'thread' } }
      )
      // The turn on acp-1 is found, so the exchange is saved; the loss has no warning yet.
      expect(await readDecisions(savedSession)).toEqual({ unsaved: false, losses: [lostKey] })
      // An unreadable chat cannot prove no exchange; its writer still owns warning admission.
      const unreadable: AcpSavedSessionReads = {
        hasProviderTurn: () => Promise.reject(new Error('journal unreadable'))
      }
      expect(await readDecisions(unreadable)).toEqual({ unsaved: false, losses: [lostKey] })
    } finally {
      await journals.closeAll()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('starts a new OMP chat with its saved model on the launch line, where OMP resolves roles', async () => {
    const start = (resumes: boolean) =>
      resolver(
        ompRecord({ model: '@worker_be', effort: 'medium' }, resumes),
        NOTHING_SAVED,
        OMP
      ).resolve({ identity })
    const fresh = await start(false)
    expect(fresh.args.slice(-2)).toEqual(['--model', '@worker_be'])
    expect(fresh.args).not.toContain('--thinking')
    expect(fresh.launchModel).toBe('@worker_be')
    // A load restores the conversation's own model; the session applies the saved one instead.
    const resumed = await start(true)
    expect(resumed.args).not.toContain('--model')
    expect(resumed.launchModel).toBeUndefined()
  })
})

describe('ACP launch folder of a floating chat', () => {
  const floating = (launchDirectory?: string) =>
    grokRecord({
      location: { ...grokRecord().location, workspaceId: FLOATING_TERMINAL_WORKTREE_ID },
      ...(launchDirectory ? { launchDirectory } : {})
    })
  const resolveIn = (record: AgentSessionRecord, currentSetting: string) => {
    const resolveWorkspacePath = vi.fn(async () => currentSetting)
    const pinLaunchDirectory = vi.fn()
    const resolve = createAcpStructuredLaunchResolver(GROK, {
      store: { getRecord: () => record, pinLaunchDirectory },
      savedSession: NOTHING_SAVED,
      resolveWorkspacePath,
      resolveEnvironment: async () => ({ PATH: '/usr/bin', HOME: '/home/user' }),
      resolveCommand: (command) => `/resolved/${command}`
    })
    return { resolve, resolveWorkspacePath, pinLaunchDirectory }
  }

  it('launches in the folder the chat was pinned to after the floating setting moved', async () => {
    const pinned = mkdtempSync(join(tmpdir(), 'orca-acp-floating-'))
    try {
      const { resolve, resolveWorkspacePath } = resolveIn(floating(pinned), '/floating/moved')
      await expect(resolve({ identity })).resolves.toMatchObject({ cwd: pinned })
      expect(resolveWorkspacePath).not.toHaveBeenCalled()
    } finally {
      rmSync(pinned, { recursive: true, force: true })
    }
  })

  it('refuses with the folder-missing reason when the pinned folder is gone', async () => {
    const gone = mkdtempSync(join(tmpdir(), 'orca-acp-floating-gone-'))
    rmSync(gone, { recursive: true, force: true })
    onTestFinished(() => rmSync(gone, { recursive: true, force: true }))
    const { resolve } = resolveIn(floating(gone), '/floating/moved')
    await expect(resolve({ identity })).rejects.toMatchObject({
      name: 'AgentSessionPreSpawnError',
      reason: 'launchFolderMissing'
    })
  })
})
