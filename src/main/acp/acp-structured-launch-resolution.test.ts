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
} from '../native-chat/agent-session-journal/journal-open'
import {
  openTestJournalHostDatabase,
  closeTestJournalHostDatabase,
  publishTestJournalEpoch,
  insertTestJournalRow,
  insertTestJournalRowJson
} from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { publishJournalOutcomeEpoch } from '../native-chat/agent-session-journal/journal-outcome-write'
import { JOURNAL_OUTCOME_FORMAT } from '../native-chat/agent-session-journal/journal-outcome-format'
import type { JournalRow } from '../native-chat/agent-session-journal/journal-row-schema'
import { createJournalReducerState } from '../native-chat/agent-session-journal/journal-reducer'
import { agentJournalItemKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  createLegacyProviderTimelineIdentityScheme,
  spellProviderTimelineKey
} from '../native-chat/agent-session-timeline/provider-timeline-identity'
import { acpLaunchSpecFor } from './acp-launch-specs'

const GROK = acpLaunchSpecFor('grok')!
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

function resolver(record: AgentSessionRecord, readJournal: () => JournalLoad | null = () => null) {
  const searched: (string | null | undefined)[] = []
  return {
    searched,
    resolve: createAcpStructuredLaunchResolver(GROK, {
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

  it.each([
    ['adopted', true],
    ['created', undefined],
    ['resumed', undefined]
  ] as const)('marks a head link of origin %s as adopted: %s', async (origin, adopted) => {
    const handle: AgentSessionProviderHandle = {
      transport: 'acp',
      agent: 'grok',
      nativeId: 'acp-1'
    }
    const record = grokRecord({
      providerHandleChain: [{ linkId: 'head', origin, mintedAtFence: 1, observedAt: 1, handle }]
    })
    const launch = await resolver(record).resolve({ identity })
    expect(launch.resume?.adopted).toBe(adopted)
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
