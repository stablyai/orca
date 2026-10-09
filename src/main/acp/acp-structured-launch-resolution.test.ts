import { describe, expect, it } from 'vitest'
import {
  agentSessionProviderHandleKey,
  type AgentSessionProviderHandle
} from '../../shared/agent-session-provider-handle'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import type { JournalLoad } from '../native-chat/agent-session-journal/journal-open'
import { createJournalReducerState } from '../native-chat/agent-session-journal/journal-reducer'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import {
  createLegacyProviderTimelineIdentityScheme,
  spellProviderTimelineKey
} from '../native-chat/agent-session-timeline/provider-timeline-identity'
import { createProviderSpawnSpec } from '../provider-process/provider-process-supervisor'
import { ACP_CHILD_ENV_TO_DELETE, acpLaunchSpecFor } from './acp-launch-specs'
import { acpSessionNotRestoredItem } from './acp-session-reopen-failure'
import { createAcpStructuredLaunchResolver } from './acp-structured-launch-resolution'

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

/** A journal holding one turn of each named provider session. */
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
  fullAccess = false,
  readJournal: () => JournalLoad | null = () => null
) {
  const searched: (string | null | undefined)[] = []
  return {
    searched,
    resolve: createAcpStructuredLaunchResolver(GROK, {
      store: { getRecord: () => record },
      readJournal,
      resolveWorkspacePath: async () => '/repo/worktree',
      resolveEnvironment: async () => ({ PATH: '/usr/bin', HOME: '/home/user' }),
      resolveLaunchEnv: () => ({ GROK_EXTRA: '1' }),
      resolveFullAccess: () => fullAccess,
      resolveCommand: (command, options) => {
        searched.push(options?.pathEnv)
        return `/resolved/${command}`
      }
    })
  }
}

describe('ACP launch resolution', () => {
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
    const readJournal = () => {
      throw new Error('old history must not be sampled for resume')
    }
    const launch = await resolver(value, false, readJournal).resolve({ identity })
    expect(launch.resume).toBeNull()
  })

  it('asks the agent to approve everything only under full access', async () => {
    const launch = await resolver(grokRecord(), true).resolve({ identity })
    expect(launch.args).toContain('--always-approve')
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
      false,
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
      (await resolver(created, false, readJournal).resolve({ identity })).resume?.mayBeUnsaved()
    const reads: string[] = []
    const launch = await resolver(created, false, () => {
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
    /** A journal holding the row for `lostKey`, written while `providerSession` ran. */
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
      (await resolver(record, false, readJournal).resolve({ identity })).resume?.unannouncedLosses()

    const reads: string[] = []
    // A chain that lost nothing never reads the journal.
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
    await expect(resolver(remote).resolve({ identity })).rejects.toThrow(/run on this runtime/)
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
        envToDelete: ACP_CHILD_ENV_TO_DELETE
      },
      inherited,
      'win32'
    )
    expect(Object.keys(spec.env).filter((key) => key.startsWith('ORCA_'))).toEqual([])
    expect(spec.env).toMatchObject({ PATH: '/usr/bin', GROK_HOME: '/home/user/.grok' })
  })
})
