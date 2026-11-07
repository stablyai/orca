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
import {
  replayJournal,
  restoreJournal,
  type JournalLoad
} from '../native-chat/agent-session-journal/replay/journal-open'
import {
  openTestJournalHostDatabase,
  closeTestJournalHostDatabase,
  publishTestJournalEpoch,
  insertTestJournalRow,
  insertTestJournalRowJson
} from '../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { publishJournalOutcomeEpoch } from '../native-chat/agent-session-journal/outcomes/journal-outcome-write'
import { JOURNAL_OUTCOME_FORMAT } from '../native-chat/agent-session-journal/outcomes/journal-outcome-format'
import type { JournalRow } from '../native-chat/agent-session-journal/durable-rows/journal-row-schema'
import { createJournalReducerState } from '../native-chat/agent-session-journal/projection/journal-reducer'
import { agentJournalItemKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  createLegacyProviderTimelineIdentityScheme,
  spellProviderTimelineKey
} from '../native-chat/agent-session-timeline/provider-timeline-identity'
import { acpLaunchSpecFor } from './acp-launch-specs'

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

function journalWithTurns(...providerSessions: string[]): JournalLoad {
  const state = createJournalReducerState(identity.sessionId, 'epoch-1')
  providerSessions.forEach((providerSession, index) => {
    const turnId = spellProviderTimelineKey(providerSession, {
      source: 'provider',
      value: `prompt:m${index}`
    })
    state.items.set(`turn-${index}`, {
      itemId: `turn-${index}`,
      revision: 1,
      sequence: index + 2,
      observedAt: 1,
      body: { kind: 'turn', turnId, state: 'completed' }
    })
  })
  return { state, newer: null, damage: null }
}

function resolver(
  record: AgentSessionRecord,
  readJournal: () => JournalLoad | null = () => null,
  spec = GROK
) {
  const searched: (string | null | undefined)[] = []
  return {
    searched,
    resolve: createAcpStructuredLaunchResolver(spec, {
      store: { getRecord: () => record, pinLaunchDirectory: vi.fn() },
      readJournal,
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
  it.each([
    ['an exchanged turn', () => journalWithTurns('acp-1')],
    [
      'an unreadable journal',
      () => {
        throw new Error('unreadable')
      }
    ]
  ])(
    'refuses a created Gemini handle with %s before any environment lookup',
    async (_label, readJournal) => {
      const record = grokRecord({
        provider: 'gemini',
        accountHome: { variable: 'GEMINI_CLI_HOME', path: '/accounts/gemini' },
        providerHandleChain: [
          {
            linkId: 'created-link',
            origin: 'created',
            mintedAtFence: 1,
            observedAt: 1,
            handle: { transport: 'acp', agent: 'gemini', nativeId: 'acp-1' }
          }
        ]
      })
      const resolveEnvironment = vi.fn(async () => ({}))
      const resolve = createAcpStructuredLaunchResolver(acpLaunchSpecFor('gemini')!, {
        store: { getRecord: () => record, pinLaunchDirectory: vi.fn() },
        readJournal,
        resolveEnvironment
      })
      await expect(resolve({ identity: { ...identity, agent: 'gemini' } })).rejects.toMatchObject({
        name: 'AgentSessionPreSpawnError',
        reason: 'providerResumeUnavailable'
      })
      expect(resolveEnvironment).not.toHaveBeenCalled()
    }
  )

  it('preserves resume and loss-warning decisions through a restore and an unreadable tail', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-acp-saved-read-'))
    const database = openTestJournalHostDatabase(root)
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
      publishTestJournalEpoch(database.db, identity.sessionId, 'epoch-1')
      insertTestJournalRow(database.db, identity.sessionId, {
        v: 4,
        epoch: 'epoch-1',
        seq: 1,
        fence: 1,
        ts: 1,
        kind: 'epoch',
        reason: 'session_created',
        providerHandle: { kind: 'opaque', agent: 'grok', value: 'acp-1' }
      })
      const turn = [...journalWithTurns('acp-1').state.items.values()][0]!
      const turnIdentity = createLegacyProviderTimelineIdentityScheme({
        agent: 'grok',
        sessionId: identity.sessionId
      }).item({
        namespace: 'acp-1',
        family: 'item',
        key: { source: 'provider', value: 'turn' },
        thread: 'acp-1'
      })
      insertTestJournalRow(database.db, identity.sessionId, {
        v: 4,
        epoch: 'epoch-1',
        seq: 2,
        fence: 1,
        ts: 2,
        kind: 'item',
        itemId: agentJournalItemKey(turnIdentity),
        revision: 1,
        body: turn.body
      })
      const readDecisions = async (readJournal: () => JournalLoad | null) => {
        const launch = await resolver(record, readJournal).resolve({ identity })
        return {
          unsaved: launch.resume?.mayBeUnsaved(),
          losses: launch.resume?.unannouncedLosses()
        }
      }
      const full = () => replayJournal(database.db, identity.sessionId)
      const restored = () => restoreJournal(database.db, identity.sessionId)
      expect(await readDecisions(restored)).toStrictEqual(await readDecisions(full))
      expect(await readDecisions(restored)).toEqual({ unsaved: false, losses: [lostKey] })
      insertTestJournalRowJson(database.db, identity.sessionId, 3, '{damaged')
      expect(await readDecisions(restored)).toStrictEqual(await readDecisions(full))
      expect(await readDecisions(restored)).toEqual({ unsaved: false, losses: [] })
    } finally {
      await closeTestJournalHostDatabase(root)
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reads an outcome chat from its records, and a newer one as unreadable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-acp-outcome-read-'))
    const database = openTestJournalHostDatabase(root)
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
      const turn = [...journalWithTurns('acp-1').state.items.values()][0]!
      const rows: JournalRow[] = [
        {
          v: 4,
          epoch: 'epoch-1',
          seq: 1,
          fence: 1,
          ts: 1,
          kind: 'epoch',
          reason: 'session_created',
          providerHandle: { kind: 'opaque', agent: 'grok', value: 'acp-1' }
        },
        {
          v: 4,
          epoch: 'epoch-1',
          seq: 2,
          fence: 1,
          ts: 2,
          kind: 'item',
          itemId: 'turn',
          revision: 1,
          body: turn.body
        }
      ]
      // A chat this build created holds only records.
      database.transaction((db) => {
        publishTestJournalEpoch(db, identity.sessionId, 'epoch-1')
        publishJournalOutcomeEpoch(db, identity.sessionId, 'epoch-1', rows)
      })
      const readDecisions = async () => {
        const launch = await resolver(record, () =>
          restoreJournal(database.db, identity.sessionId)
        ).resolve({ identity })
        return {
          unsaved: launch.resume?.mayBeUnsaved(),
          losses: launch.resume?.unannouncedLosses()
        }
      }
      expect(restoreJournal(database.db, identity.sessionId)?.state.items.has('turn')).toBe(true)
      // The turn on acp-1 is found, so the exchange is saved; the loss has no warning yet.
      expect(await readDecisions()).toEqual({ unsaved: false, losses: [lostKey] })
      // A newer build's records are unreadable here, never a missing chat.
      database.db
        .prepare('UPDATE journal_outcome_epochs SET format = ?')
        .run(JOURNAL_OUTCOME_FORMAT + 1)
      const newer = restoreJournal(database.db, identity.sessionId)
      expect(newer).not.toBeNull()
      expect(newer?.newer).toStrictEqual({ sequence: 1 })
      expect(newer?.damage).toBeNull()
      expect(await readDecisions()).toEqual({ unsaved: false, losses: [] })
    } finally {
      await closeTestJournalHostDatabase(root)
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('starts a new OMP chat with its saved model on the launch line, where OMP resolves roles', async () => {
    const start = (resumes: boolean) =>
      resolver(
        ompRecord({ model: '@worker_be', effort: 'medium' }, resumes),
        () => null,
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
      readJournal: () => null,
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
