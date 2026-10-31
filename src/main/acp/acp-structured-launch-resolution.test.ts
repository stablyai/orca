import { createAcpStructuredLaunchResolver } from '../runtime/structured-agent-launch-composition.test-support'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import {
  agentSessionProviderHandleKey,
  type AgentSessionProviderHandle
} from '../../shared/agent-session-provider-handle'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { replayJournal, restoreJournal } from '../native-chat/agent-session-journal/journal-open'
import {
  openTestJournalHostDatabase,
  closeTestJournalHostDatabase,
  publishTestJournalEpoch,
  insertTestJournalRow,
  insertTestJournalRowJson
} from '../native-chat/agent-session-journal/journal-host-database-test-support'
import type { JournalLoad } from '../native-chat/agent-session-journal/journal-open'
import { publishJournalOutcomeEpoch } from '../native-chat/agent-session-journal/journal-outcome-write'
import type { JournalRow } from '../native-chat/agent-session-journal/journal-row-schema'
import { createJournalReducerState } from '../native-chat/agent-session-journal/journal-reducer'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import {
  createLegacyProviderTimelineIdentityScheme,
  spellProviderTimelineKey
} from '../native-chat/agent-session-timeline/provider-timeline-identity'
import { createProviderSpawnSpec } from '../provider-process/provider-process-supervisor'
import { acpLaunchSpecFor } from './acp-launch-specs'
import { STRUCTURED_CHILD_ENV_TO_DELETE } from '../runtime/structured-session-child-env'
import { acpSessionNotRestoredItem } from './acp-session-reopen-failure'

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
      database.db.prepare('UPDATE journal_outcome_epochs SET format = 2').run()
      expect(restoreJournal(database.db, identity.sessionId)?.newer).toBeTruthy()
      expect(await readDecisions()).toEqual({ unsaved: false, losses: [] })
    } finally {
      await closeTestJournalHostDatabase(root)
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('pins the record account home and searches the agent install dir', async () => {
    const { resolve, searched } = resolver(grokRecord())
    const launch = await resolve({ identity })
    expect(launch).toMatchObject({
      command: '/resolved/grok',
      args: ['agent', 'stdio'],
      cwd: '/repo/worktree',
      fullAccess: false,
      resume: null
    })
    expect(launch.env).toMatchObject({
      GROK_HOME: '/home/user/.grok-work',
      GROK_EXTRA: '1'
    })
    expect(searched[0]).toContain('/home/user/.grok-work/bin')
  })

  it('creates a new ACP session after clear instead of probing the old session', async () => {
    const value = grokRecord({
      providerContextBoundary: { operationId: 'clear', afterFence: 2, clearedAt: 100 },
      providerHandleChain: []
    })
    const readJournal = vi.fn(() => null)
    const launch = await resolver(value, readJournal).resolve({ identity })
    expect(launch.resume).toBeNull()
    expect(readJournal).not.toHaveBeenCalled()
  })

  it("asks the agent to approve everything only under the chat's full access", async () => {
    const start = (permissionMode: 'ask' | 'full-access') =>
      resolver(grokRecord()).resolve({ identity, spawnToken: 'token', permissionMode })
    expect((await start('full-access')).args).toContain('--always-approve')
    expect((await start('ask')).args).not.toContain('--always-approve')
  })

  it('resumes the chain head by its key, possibly unsaved only when this chat created it', async () => {
    const link = (origin: 'created' | 'resumed') => ({
      linkId: `link-${origin}`,
      origin,
      mintedAtFence: 1,
      observedAt: 1,
      handle: { transport: 'acp', agent: 'grok', nativeId: 'acp-1' }
    })
    const created = await resolver(grokRecord({ providerHandleChain: [link('created')] })).resolve({
      identity
    })
    const handle: AgentSessionProviderHandle = {
      transport: 'acp',
      agent: 'grok',
      nativeId: 'acp-1'
    }
    const key = agentSessionProviderHandleKey(handle)
    expect(created.resume).toMatchObject({ sessionId: 'acp-1', key })
    expect(created.resume?.mayBeUnsaved()).toBe(true)
    const resumed = await resolver(
      grokRecord({ providerHandleChain: [link('created'), link('resumed')] }),
      () => journalWithTurns()
    ).resolve({ identity })
    expect(resumed.resume).toMatchObject({ sessionId: 'acp-1', key })
    expect(resumed.resume?.mayBeUnsaved()).toBe(false)
  })

  it('counts a created session as possibly unsaved only while the journal proves no turn on it', async () => {
    const created = grokRecord({
      providerHandleChain: [
        {
          linkId: 'link-created',
          origin: 'created',
          mintedAtFence: 1,
          observedAt: 1,
          handle: { transport: 'acp', agent: 'grok', nativeId: 'acp-1' }
        }
      ]
    })
    const unsaved = async (readJournal: () => JournalLoad | null) =>
      (await resolver(created, readJournal).resolve({ identity })).resume?.mayBeUnsaved()
    const reads: string[] = []
    const launch = await resolver(created, () => {
      reads.push('read')
      return null
    }).resolve({ identity })
    // Read only when asked: a reopen that works never replays the journal.
    expect(reads).toEqual([])
    expect(launch.resume?.mayBeUnsaved()).toBe(true)

    expect(await unsaved(() => journalWithTurns())).toBe(true)
    expect(await unsaved(() => journalWithTurns('acp-other'))).toBe(true)
    expect(await unsaved(() => journalWithTurns('acp-other', 'acp-1'))).toBe(false)
    // A journal that does not read whole, or at all, proves nothing.
    expect(
      await unsaved(() => ({
        ...journalWithTurns(),
        damage: { sequence: 3, cause: 'sequence-gap' }
      }))
    ).toBe(false)
    expect(await unsaved(() => ({ ...journalWithTurns(), newer: { sequence: 3 } }))).toBe(false)
    expect(
      await unsaved(() => {
        throw new Error('journal_closed')
      })
    ).toBe(false)
  })

  it('names the lost conversations whose warning row no session of the chat wrote', async () => {
    const link = (nativeId: string, replaced?: string) => ({
      linkId: `link-${nativeId}`,
      origin: 'created' as const,
      mintedAtFence: 1,
      observedAt: 1,
      handle: { transport: 'acp', agent: 'grok', nativeId },
      ...(replaced
        ? {
            replaces: {
              key: agentSessionProviderHandleKey({
                transport: 'acp',
                agent: 'grok',
                nativeId: replaced
              }),
              reason: 'restore-failed',
              replacedAt: 1
            }
          }
        : {})
    })
    const lostKey = agentSessionProviderHandleKey({
      transport: 'acp',
      agent: 'grok',
      nativeId: 'acp-1'
    })
    const replaced = grokRecord({ providerHandleChain: [link('acp-1'), link('acp-2', 'acp-1')] })
    const withRow = (providerSession: string): JournalLoad => {
      const load = journalWithTurns()
      const itemId = agentJournalItemKey(
        createLegacyProviderTimelineIdentityScheme({
          agent: 'grok',
          sessionId: identity.sessionId
        }).item({
          namespace: providerSession,
          family: 'item',
          key: { source: 'provider', value: acpSessionNotRestoredItem(lostKey) },
          thread: providerSession
        })
      )
      load.state.items.set(itemId, {
        itemId,
        revision: 1,
        sequence: 2,
        observedAt: 1,
        body: { kind: 'status', tone: 'warning', text: 'forgot' }
      })
      return load
    }
    const losses = async (record: AgentSessionRecord, readJournal: () => JournalLoad | null) =>
      (await resolver(record, readJournal).resolve({ identity })).resume?.unannouncedLosses()

    const reads: string[] = []
    expect(
      await losses(grokRecord({ providerHandleChain: [link('acp-1')] }), () => {
        reads.push('read')
        return null
      })
    ).toEqual([])
    expect(reads).toEqual([])
    expect(await losses(replaced, () => null)).toEqual([lostKey])
    expect(await losses(replaced, () => journalWithTurns('acp-2'))).toEqual([lostKey])
    expect(await losses(replaced, () => withRow('acp-2'))).toEqual([])
    // A row the superseded replacement wrote still counts.
    expect(await losses(replaced, () => withRow('acp-gone'))).toEqual([])
    // A journal that does not read whole proves nothing, so no row is written.
    expect(
      await losses(replaced, () => ({
        ...journalWithTurns(),
        damage: { sequence: 3, cause: 'sequence-gap' }
      }))
    ).toEqual([])
    expect(
      await losses(replaced, () => {
        throw new Error('journal_closed')
      })
    ).toEqual([])
  })

  it('refuses a record pinned to another host or another agent', async () => {
    const remote = grokRecord()
    remote.location = { ...remote.location, executionHostId: 'ssh:box' }
    await expect(resolver(remote).resolve({ identity })).rejects.toThrow(/run on the local host/)
    await expect(resolver(agentSessionRecordFixture()).resolve({ identity })).rejects.toThrow(
      /claude session/
    )
  })
})

describe('Grok status: the structured session is the only producer', () => {
  it('strips every pane identity and hook endpoint an inherited environment carries', () => {
    const inherited = {
      PATH: '/usr/bin',
      ORCA_PANE_KEY: 'tab-1:pane-1',
      ORCA_AGENT_PANE: 'tab-1:pane-1',
      ORCA_TAB_ID: 'tab-1',
      ORCA_WORKTREE_ID: 'wt-1',
      ORCA_AGENT_LAUNCH_TOKEN: 'launch-1',
      ORCA_AGENT_HOOK_PORT: '4321',
      ORCA_AGENT_HOOK_TOKEN: 'secret',
      ORCA_AGENT_HOOK_ENDPOINT: '/tmp/endpoint'
    }
    const spec = createProviderSpawnSpec(
      {
        command: 'grok',
        args: ['agent', 'stdio'],
        env: { GROK_HOME: '/home/user/.grok' },
        envToDelete: STRUCTURED_CHILD_ENV_TO_DELETE
      },
      inherited,
      'win32'
    )
    expect(Object.keys(spec.env).filter((key) => key.startsWith('ORCA_'))).toEqual([])
    expect(spec.env).toMatchObject({ PATH: '/usr/bin', GROK_HOME: '/home/user/.grok' })
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

  it('pins an unpinned floating record to the folder its first launch runs in', async () => {
    const { resolve, pinLaunchDirectory } = resolveIn(floating(), '/floating/start')
    await expect(resolve({ identity })).resolves.toMatchObject({ cwd: '/floating/start' })
    expect(pinLaunchDirectory).toHaveBeenCalledExactlyOnceWith(
      identity.sessionId,
      '/floating/start'
    )
  })

  it('keeps resolving a worktree chat by its workspace, ignoring any recorded folder', async () => {
    const { resolve, resolveWorkspacePath, pinLaunchDirectory } = resolveIn(
      grokRecord({ launchDirectory: '/somewhere/else' }),
      '/repo/worktree'
    )
    await expect(resolve({ identity })).resolves.toMatchObject({ cwd: '/repo/worktree' })
    expect(resolveWorkspacePath).toHaveBeenCalledWith('workspace-1')
    expect(pinLaunchDirectory).not.toHaveBeenCalled()
  })
})
