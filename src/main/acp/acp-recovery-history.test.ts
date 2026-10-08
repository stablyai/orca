import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalSubmission } from '../../shared/agent-session-journal-types'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import type { JournalLoad } from '../native-chat/agent-session-journal/journal-open'
import { createJournalReducerState } from '../native-chat/agent-session-journal/journal-reducer'
import { reconcileSubmissions } from '../native-chat/agent-session-journal/journal-submission-reconciler'
import { acpLaunchSpecFor } from './acp-launch-specs'
import { readAcpRecoveryHistory, type AcpStoredUserMessage } from './acp-recovery-history'
import type { AcpStructuredLaunch } from './acp-structured-launch-resolution'

const SESSION = 'session-alpha-1'
const identity = {
  sessionId: SESSION,
  workspaceId: 'workspace-1',
  hostId: 'local',
  agent: 'opencode',
  providerHandle: null
}

function fingerprint(text: string): string {
  return computeAgentSessionPayloadFingerprint({
    method: 'agentSession.send',
    sessionId: SESSION,
    fields: { body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] } }
  })
}

function submission(
  clientMessageId: string,
  text: string,
  dispatchState: AgentJournalSubmission['dispatchState'],
  submittedAt: number,
  resolvedAt: number | null = null
): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: fingerprint(text),
    dispatchState,
    providerItemId: null,
    reason: null,
    submittedAt,
    resolvedAt
  }
}

function journal(...submissions: AgentJournalSubmission[]): JournalLoad {
  const state = createJournalReducerState(SESSION, 'epoch-1')
  for (const entry of submissions) {
    state.submissions.set(entry.clientMessageId, entry)
  }
  return { state, newer: null, damage: null }
}

const launch: AcpStructuredLaunch = {
  spec: acpLaunchSpecFor('opencode')!,
  command: '/resolved/opencode',
  args: ['acp'],
  cwd: '/repo',
  env: { XDG_DATA_HOME: '/data' },
  envToDelete: [],
  fullAccess: false,
  resume: {
    sessionId: 'ses_1',
    key: 'acp:opencode:ses_1',
    mayBeUnsaved: () => false,
    unannouncedLosses: () => []
  }
}

function stored(id: string, text: string, createdAt: number): AcpStoredUserMessage {
  return { id, blocks: [{ type: 'text', text }], createdAt }
}

async function windowFor(load: JournalLoad | null, messages: AcpStoredUserMessage[] | null) {
  const readStoredUserMessages = vi.fn(async () => messages)
  const window = await readAcpRecoveryHistory(
    {
      spec: { readStoredUserMessages },
      resolveLaunch: async () => launch,
      readJournal: () => load
    },
    identity
  )
  return { window, readStoredUserMessages }
}

describe('ACP restart recovery from the agent store', () => {
  it('settles a message the agent recorded after the crash as sent, under its own row', async () => {
    const load = journal(
      submission('first', 'hello', 'accepted', 100, 110),
      submission('held', 'run the tests', 'unknown', 200)
    )
    const { window, readStoredUserMessages } = await windowFor(load, [
      stored('msg_1', 'hello', 105),
      stored('msg_2', 'run the tests', 205)
    ])
    expect(readStoredUserMessages).toHaveBeenCalledWith(
      expect.objectContaining({ env: launch.env, providerSessionId: 'ses_1' })
    )
    expect(window).toMatchObject({ boundaryConsistent: false, turnInFlight: true })
    expect(
      reconcileSubmissions({ submissions: [...load.state.submissions.values()], history: window! })
    ).toEqual([
      {
        clientMessageId: 'held',
        outcome: 'accepted',
        providerItemId: 'msg_2',
        identity: { provider: 'orca', clientMessageId: 'held' }
      }
    ])
  })

  it('never offers an older identical message as the one in doubt', async () => {
    const load = journal(
      submission('first', 'continue', 'accepted', 100, 110),
      submission('held', 'continue', 'unknown', 200)
    )
    const { window } = await windowFor(load, [stored('msg_1', 'continue', 105)])
    expect(window?.items).toEqual([])
    expect(
      reconcileSubmissions({ submissions: [...load.state.submissions.values()], history: window! })
    ).toMatchObject([{ clientMessageId: 'held', outcome: 'unknown' }])
  })

  it('lets an accepted send claim its own copy even when the agent stored it after the next send', async () => {
    // Accepted at dispatch (r=500) and stored at 505; the identical send behind it was lost.
    const load = journal(
      submission('first', 'continue', 'accepted', 100, 500),
      submission('held', 'continue', 'unknown', 110)
    )
    const { window } = await windowFor(load, [stored('msg_1', 'continue', 505)])
    expect(window?.items).toEqual([])
  })

  it('keeps an older unconfirmed send from widening the window over a delivered copy', async () => {
    const load = journal(
      submission('old', 'yes', 'unknown', 50),
      submission('first', 'yes', 'accepted', 300, 300),
      submission('held', 'yes', 'unknown', 400)
    )
    const { window } = await windowFor(load, [stored('msg_1', 'yes', 303)])
    expect(window?.items).toEqual([])
  })

  it('confirms the doubted send when both identical copies are stored', async () => {
    const load = journal(
      submission('first', 'yes', 'accepted', 300, 300),
      submission('held', 'yes', 'unknown', 400)
    )
    const { window } = await windowFor(load, [
      stored('msg_1', 'yes', 303),
      stored('msg_2', 'yes', 405)
    ])
    expect(
      reconcileSubmissions({ submissions: [...load.state.submissions.values()], history: window! })
    ).toMatchObject([{ clientMessageId: 'held', outcome: 'accepted', providerItemId: 'msg_2' }])
  })

  it('reads nothing for a queued card the agent was never handed', async () => {
    const queued = { ...submission('queued', 'x', 'pending', 1), handoverRecorded: true as const }
    const { window, readStoredUserMessages } = await windowFor(journal(queued), [])
    expect(window).toBeNull()
    expect(readStoredUserMessages).not.toHaveBeenCalled()
  })

  it('reads nothing with no message in doubt, a damaged journal, or no resumable session', async () => {
    expect((await windowFor(journal(submission('a', 'x', 'accepted', 1, 2)), [])).window).toBeNull()
    const damaged = journal(submission('held', 'x', 'unknown', 1))
    expect(
      (await windowFor({ ...damaged, damage: { sequence: 3, cause: 'sequence-gap' } }, [])).window
    ).toBeNull()
    const readStoredUserMessages = vi.fn(async () => [])
    await expect(
      readAcpRecoveryHistory(
        {
          spec: { readStoredUserMessages },
          resolveLaunch: async () => ({ ...launch, resume: null }),
          readJournal: () => journal(submission('held', 'x', 'unknown', 1))
        },
        identity
      )
    ).resolves.toBeNull()
    expect(readStoredUserMessages).not.toHaveBeenCalled()
  })

  it('reads nothing for an agent whose store Orca does not read', async () => {
    await expect(
      readAcpRecoveryHistory(
        {
          spec: {},
          resolveLaunch: async () => launch,
          readJournal: () => journal(submission('held', 'x', 'unknown', 1))
        },
        identity
      )
    ).resolves.toBeNull()
  })

  it('answers null, never throws, when the store cannot be read', async () => {
    const warn = vi.fn()
    await expect(
      readAcpRecoveryHistory(
        {
          spec: {
            readStoredUserMessages: async () => {
              throw new Error('database is locked')
            }
          },
          resolveLaunch: async () => launch,
          readJournal: () => journal(submission('held', 'x', 'unknown', 1)),
          logger: { warn, error: vi.fn() }
        },
        identity
      )
    ).resolves.toBeNull()
    expect(warn).toHaveBeenCalled()
  })
})
