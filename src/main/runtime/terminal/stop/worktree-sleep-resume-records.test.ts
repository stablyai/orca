import { expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import {
  applyWorktreeSleepResumeRecords,
  captureWorktreeSleepResumeRecords
} from './worktree-sleep-resume-records'

const PANE = 'tab-a:11111111-1111-4111-8111-111111111111'

/** Main's sleep of the pane's Claude row, reported now from `connectionId` with no new reply. */
async function sleepOver(
  previous: SleepingAgentSessionRecord
): Promise<SleepingAgentSessionRecord> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: sleep capture reads only the row's pane, agent, session, prompt, reply, connection and time.
  const row = {
    paneKey: PANE,
    agentType: 'claude',
    state: 'done',
    prompt: '',
    providerSession: { key: 'session_id', id: 'shared', transcriptPath: '/home/u/shared.jsonl' },
    connectionId: 'wsl:Ubuntu',
    receivedAt: 20
  } as unknown as AgentStatusIpcPayload
  const capture = await captureWorktreeSleepResumeRecords({
    worktreeId: 'repo::/w',
    paneKeysByPtyId: new Map([['pty-1', [PANE]]]),
    launchByPtyId: new Map(),
    readRows: () => [row],
    checkAgentPresence: null,
    capturedAt: 30
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: applying records reads and replaces only the session's sleeping records.
  const session = {
    sleepingAgentSessionsByPaneKey: { [PANE]: previous }
  } as unknown as WorkspaceSessionState
  return applyWorktreeSleepResumeRecords(session, capture, ['pty-1'])!
    .sleepingAgentSessionsByPaneKey![PANE]!
}

function saved(overrides: Partial<SleepingAgentSessionRecord>): SleepingAgentSessionRecord {
  return {
    paneKey: PANE,
    tabId: 'tab-a',
    worktreeId: 'repo::/w',
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'shared', transcriptPath: '/home/u/shared.jsonl' },
    prompt: '',
    state: 'done',
    capturedAt: 10,
    updatedAt: 10,
    connectionId: null,
    terminalTitle: 'Earlier task',
    lastAssistantMessage: 'EARLIER REPLY',
    origin: 'live',
    ...overrides
  }
}

it("saves an Ubuntu agent's sleep without an older Debian record's title or reply", async () => {
  // An older Orca saved no distro; its UNC transcript path names Debian.
  const debian = saved({
    providerSession: {
      key: 'session_id',
      id: 'shared',
      transcriptPath: '\\\\wsl.localhost\\Debian\\home\\u\\shared.jsonl'
    }
  })

  const slept = await sleepOver(debian)

  expect(slept).toMatchObject({ wslDistro: 'Ubuntu' })
  expect(slept).not.toHaveProperty('lastAssistantMessage')
  expect(slept).not.toHaveProperty('terminalTitle')
})

it("keeps the same Ubuntu conversation's title and reply through a sleep with no new reply", async () => {
  expect(await sleepOver(saved({ wslDistro: 'Ubuntu' }))).toMatchObject({
    wslDistro: 'Ubuntu',
    terminalTitle: 'Earlier task',
    lastAssistantMessage: 'EARLIER REPLY'
  })
})
