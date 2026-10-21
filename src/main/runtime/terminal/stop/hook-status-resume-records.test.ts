import { describe, expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-ipc-payload'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import {
  hookStatusResumeCommand,
  quitResumeRecords,
  resumeStatusFromHookRow
} from './hook-status-resume-records'

const WORKTREE = 'repo::/wt'
const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'
const SESSION = { key: 'session_id' as const, id: 'session-1' }
const RECIPE = { agentCommand: '/opt/codex', agentArgs: '--x', agentEnv: {} }

function row(overrides: Partial<AgentStatusIpcPayload> = {}): AgentStatusIpcPayload {
  return {
    paneKey: PANE_KEY,
    worktreeId: WORKTREE,
    agentType: 'codex',
    providerSession: SESSION,
    state: 'working',
    prompt: 'go',
    receivedAt: 5,
    stateStartedAt: 5,
    connectionId: null,
    ...overrides
  }
}

function heldSession(
  records: Record<string, SleepingAgentSessionRecord> = {}
): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE]: [
        {
          id: 'tab-1',
          ptyId: 'pty-1',
          worktreeId: WORKTREE,
          title: 'Codex',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    sleepingAgentSessionsByPaneKey: records
  }
}

function status(overrides: Partial<AgentStatusIpcPayload> = {}) {
  return resumeStatusFromHookRow(row(overrides), undefined)!
}

describe('resumeStatusFromHookRow', () => {
  it('keeps an SSH connection id and drops a WSL relay tag', () => {
    expect(status({ connectionId: 'ssh-1' }).connectionId).toBe('ssh-1')
    expect(status({ connectionId: 'wsl:Ubuntu' }).connectionId).toBeNull()
  })

  it('reads no pane status from identity-only or chat rows', () => {
    expect(resumeStatusFromHookRow(row({ providerSessionOnly: true }), undefined)).toBeNull()
    expect(resumeStatusFromHookRow(row({ structuredHost: 'owned' }), undefined)).toBeNull()
  })
})

describe('hookStatusResumeCommand', () => {
  const launchConfigOf = () => undefined

  it('records how the agent resumes, with the recipe its terminal launched', () => {
    const command = hookStatusResumeCommand({
      status: status(),
      session: heldSession(),
      worktreeId: WORKTREE,
      launchConfigOf: (paneKey, agent) =>
        paneKey === PANE_KEY && agent === 'codex' ? RECIPE : undefined
    })

    expect(command).toMatchObject({
      type: 'sleep',
      workspace: WORKTREE,
      tabId: 'tab-1',
      paneKeys: [PANE_KEY],
      recordOnly: true,
      records: [{ paneKey: PANE_KEY, terminalTitle: 'Codex', launchConfig: RECIPE, origin: 'live' }]
    })
  })

  it('keeps the recipe the pane’s earlier record of the same session kept', () => {
    const earlier = hookStatusResumeCommand({
      status: status(),
      session: heldSession(),
      worktreeId: WORKTREE,
      launchConfigOf: () => RECIPE
    })
    const [record] = earlier?.type === 'sleep' ? earlier.records : []

    const command = hookStatusResumeCommand({
      status: status({ state: 'blocked' }),
      session: heldSession({ [PANE_KEY]: record! }),
      worktreeId: WORKTREE,
      launchConfigOf
    })

    expect(command?.type === 'sleep' && command.records[0]?.launchConfig).toEqual(RECIPE)
  })

  it('drops the record of a pane whose agent can no longer be resumed', () => {
    const existing = hookStatusResumeCommand({
      status: status(),
      session: heldSession(),
      worktreeId: WORKTREE,
      launchConfigOf
    })
    const [record] = existing?.type === 'sleep' ? existing.records : []

    expect(
      hookStatusResumeCommand({
        status: status({ agentType: 'amp', providerSession: undefined }),
        session: heldSession({ [PANE_KEY]: record! }),
        worktreeId: WORKTREE,
        launchConfigOf
      })
    ).toMatchObject({ type: 'wake', paneKeys: [PANE_KEY], recordOnly: true })
  })

  it('leaves a pane the partition does not hold', () => {
    expect(
      hookStatusResumeCommand({
        status: status(),
        session: getDefaultWorkspaceSession(),
        worktreeId: WORKTREE,
        launchConfigOf
      })
    ).toBeNull()
  })
})

describe('quitResumeRecords', () => {
  it('captures held panes’ running agents as quit records and skips panes it lacks', () => {
    const records = quitResumeRecords({
      statuses: [status(), status({ paneKey: 'tab-2:22222222-2222-4222-8222-222222222222' })],
      session: heldSession(),
      worktreeIdOf: () => WORKTREE,
      launchConfigOf: () => undefined,
      capturedAt: 9
    })

    expect(records).toEqual([
      expect.objectContaining({ paneKey: PANE_KEY, origin: 'quit', capturedAt: 9 })
    ])
  })
})
