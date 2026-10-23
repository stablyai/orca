import { describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { AgentSessionResumeResult } from '../runtime/session-lifecycle/projection/resume-agent-session-in-workspace'
import type { ConversationKey } from './external-conversation-types'
import {
  fakeLauncher,
  fakeLinkStore,
  fakeTerminal,
  launchResult,
  LOCAL_REPO,
  PANE,
  REOPENED_PANE,
  SESSION,
  sessionRow,
  WORKTREE
} from './external-conversation.test-fixture'
import { deferred, harness } from './external-conversation-seam.test-fixture'

const KEY: ConversationKey = { source: 'dev', externalId: 'thread-1' }
const START = {
  agent: 'claude',
  target: { kind: 'existing' as const, worktree: `id:${WORKTREE}` },
  prompt: 'first'
}
const REOPENED = { outcome: 'accepted', reopened: true }
const UNREACHABLE = { outcome: 'refused', reason: 'agent_not_reachable' }

async function started(
  records = fakeLinkStore(),
  sshHostId: ExecutionHostId | null = null,
  terminal = fakeTerminal()
) {
  const h = harness({}, records, undefined, terminal.terminal)
  const { launcher } = fakeLauncher(async () => launchResult('handed-to-terminal'), {
    worktreeId: WORKTREE,
    sshHostId
  })
  const host = { launcher, terminal: terminal.terminal }
  await h.seam.start(host, KEY, 'start', START)
  const link = (): unknown => h.row(WORKTREE, sshHostId ?? 'local')?.externalConversations
  return { ...h, terminal, host, link }
}

describe('ExternalConversationSeam reopen', () => {
  it('captures a session already reported when the link is published', async () => {
    const { seam, host, terminal } = await started()
    terminal.exit()
    terminal.state.rows = []
    terminal.reopenable()
    expect(await seam.send(host, KEY, 'early-report', 'next')).toEqual(REOPENED)
  })

  it('never adopts a replacement process while the reopened agent becomes ready', async () => {
    const { seam, host, terminal, reportSessions } = await started()
    reportSessions([{ paneKey: PANE, sessionId: SESSION.id }])
    terminal.exit()
    terminal.reopenable()
    terminal.waitForFreshWorkerComposer.mockImplementationOnce(async () => {
      terminal.replace()
      return {
        handle: 'term-2',
        condition: 'tui-idle',
        satisfied: true,
        status: 'running',
        exitCode: null
      }
    })
    const head = seam.send(host, KEY, 'replacement-head', 'one')
    const follower = seam.send(host, KEY, 'replacement-follower', 'two')
    expect(await head).toEqual(UNREACHABLE)
    expect(await follower).toEqual(UNREACHABLE)
    expect(terminal.writes).toEqual([])
  })

  it('reopens a closed tab’s agent from the session hooks reported, and sends to it', async () => {
    const { seam, host, terminal, reportSessions, link } = await started()
    reportSessions([{ paneKey: PANE, sessionId: SESSION.id }])
    expect(link()).toEqual([
      expect.objectContaining({ paneKey: PANE, providerSession: SESSION, captureHostId: 'local' })
    ])
    // The tab closes: its PTY and its hook rows go with it.
    terminal.exit()
    terminal.reopenable()
    expect(await seam.send(host, KEY, 'd1', 'what did you say?')).toEqual(REOPENED)
    expect(terminal.resumeAgentSessionInWorkspace).toHaveBeenCalledWith(WORKTREE, {
      agent: 'claude',
      providerSession: SESSION,
      captureHostId: 'local',
      mutationId: expect.stringContaining('d1'),
      signal: expect.any(AbortSignal)
    })
    expect(terminal.waitForFreshWorkerComposer).toHaveBeenCalled()
    expect(terminal.writes).toEqual(['what did you say?'])
    expect(terminal.sendTerminalAgentPrompt).toHaveBeenLastCalledWith(
      'term-2',
      'what did you say?',
      expect.objectContaining({
        expectedBinding: { ptyId: 'pty-2', processIncarnation: 'inc-pty-2' }
      })
    )
    expect(link()).toEqual([expect.objectContaining({ paneKey: REOPENED_PANE })])
    // The reopened agent is the conversation's from now on.
    expect(await seam.send(host, KEY, 'd2', 'next')).toEqual({ outcome: 'accepted' })
    expect(terminal.resumeAgentSessionInWorkspace).toHaveBeenCalledTimes(1)
  })

  it('reopens an agent that exited to its shell, from the session captured at an earlier send', async () => {
    const { seam, host, terminal, link } = await started()
    expect(await seam.send(host, KEY, 'd1', 'one')).toEqual({ outcome: 'accepted' })
    expect(link()).toEqual([expect.objectContaining({ providerSession: SESSION })])
    terminal.state.rows = []
    terminal.terminal.readLaunchedAgentForeground.mockImplementation(async (ptyId: string) =>
      ptyId === 'pty-1' ? 'shell' : 'agent'
    )
    terminal.reopenable()
    expect(await seam.send(host, KEY, 'd2', 'two')).toEqual(REOPENED)
    expect(terminal.writes).toEqual(['one', 'two'])
  })

  it('keeps a reopened answer for a repeated delivery id without reopening again', async () => {
    const { seam, host, terminal, reportSessions } = await started()
    reportSessions([{ paneKey: PANE, sessionId: SESSION.id }])
    terminal.exit()
    terminal.reopenable()
    expect(await seam.send(host, KEY, 'd1', 'x')).toEqual(REOPENED)
    expect(await seam.send(host, KEY, 'd1', 'x')).toEqual(REOPENED)
    expect(terminal.resumeAgentSessionInWorkspace).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['window_owns_wake', 'agent_asleep_in_window'],
    ['no_resume_command', 'reopen_refused'],
    ['create_failed', 'reopen_refused'],
    ['held_elsewhere', 'agent_not_reachable']
  ] as const)(
    'refuses with its reason when the resume answers %s, and so does a follower',
    async (resumeRefusal, reason) => {
      const { seam, host, terminal, reportSessions, link } = await started()
      reportSessions([{ paneKey: PANE, sessionId: SESSION.id }])
      terminal.exit()
      terminal.resumeAgentSessionInWorkspace.mockResolvedValue({ ok: false, reason: resumeRefusal })
      const head = seam.send(host, KEY, 'd1', 'one')
      const follower = seam.send(host, KEY, 'd2', 'two')
      expect(await head).toEqual({ outcome: 'refused', reason })
      expect(await follower).toEqual({ outcome: 'refused', reason })
      expect(terminal.resumeAgentSessionInWorkspace).toHaveBeenCalledTimes(1)
      expect(terminal.writes).toEqual([])
      expect(link()).toEqual([expect.objectContaining({ paneKey: PANE })])
    }
  )

  it('refuses without asking the resume when no session id is known', async () => {
    const terminal = fakeTerminal()
    terminal.state.rows = []
    const { seam, host } = await started(undefined, null, terminal)
    terminal.exit()
    terminal.reopenable()
    expect(await seam.send(host, KEY, 'd1', 'x')).toEqual({
      outcome: 'refused',
      reason: 'no_session_to_reopen'
    })
    expect(terminal.resumeAgentSessionInWorkspace).not.toHaveBeenCalled()
  })

  it('does not reopen an SSH agent out of contact: the old pane may still hold it', async () => {
    const records = fakeLinkStore([LOCAL_REPO, { ...LOCAL_REPO, connectionId: 'box' }])
    records.put(WORKTREE, 'ssh:box', {})
    const { seam, host, terminal, link } = await started(records, 'ssh:box')
    terminal.state.rows = [sessionRow(PANE, 'box')]
    expect(await seam.send(host, KEY, 'd1', 'one')).toEqual({ outcome: 'accepted' })
    // The relay drops: the PTY stays registered but cannot be written, and nothing proves an exit.
    terminal.sendTerminalAgentPrompt.mockRejectedValueOnce(new Error('terminal_not_writable'))
    expect(await seam.send(host, KEY, 'd2', 'two')).toEqual(UNREACHABLE)
    expect(terminal.resumeAgentSessionInWorkspace).toHaveBeenCalledWith(
      WORKTREE,
      expect.objectContaining({ captureHostId: 'ssh:box' })
    )
    expect(terminal.writes).toEqual(['one'])
    expect(link()).toEqual([expect.objectContaining({ paneKey: PANE })])
  })

  it('does not reopen for a follower whose lane already wrote to the process that exited', async () => {
    const { seam, host, terminal, reportSessions } = await started()
    reportSessions([{ paneKey: PANE, sessionId: SESSION.id }])
    terminal.reopenable()
    terminal.sendTerminalAgentPrompt.mockImplementationOnce(async (handle, prompt) => {
      terminal.writes.push(prompt)
      terminal.exit()
      return { handle, accepted: true, bytesWritten: 1 }
    })
    const head = seam.send(host, KEY, 'd1', 'one')
    const follower = seam.send(host, KEY, 'd2', 'two')
    expect(await head).toEqual({ outcome: 'accepted' })
    expect(await follower).toEqual(UNREACHABLE)
    expect(terminal.resumeAgentSessionInWorkspace).not.toHaveBeenCalled()
    // The next message opens a new lane, which reopens.
    expect(await seam.send(host, KEY, 'd3', 'three')).toEqual(REOPENED)
    expect(terminal.writes).toEqual(['one', 'three'])
  })

  it('reopens for a held head whose agent exits, and sends its follower to the new agent', async () => {
    const { seam, host, terminal, reportSessions } = await started()
    reportSessions([{ paneKey: PANE, sessionId: SESSION.id }])
    terminal.reopenable()
    terminal.state.blocked = true
    const head = seam.send(host, KEY, 'd1', 'one')
    const follower = seam.send(host, KEY, 'd2', 'two')
    await vi.waitFor(() => expect(terminal.held()).toBe(1))
    terminal.state.blocked = false
    terminal.exit()
    expect(await head).toEqual(REOPENED)
    expect(await follower).toEqual({ outcome: 'accepted' })
    expect(terminal.writes).toEqual(['one', 'two'])
  })

  it('queues a second message behind a reopen and sends it to the reopened agent', async () => {
    const { seam, host, terminal, reportSessions } = await started()
    reportSessions([{ paneKey: PANE, sessionId: SESSION.id }])
    terminal.exit()
    const resumed = deferred<void>()
    terminal.resumeAgentSessionInWorkspace.mockImplementation(
      async (): Promise<AgentSessionResumeResult> => {
        await resumed.promise
        terminal.state.paneKey = REOPENED_PANE
        terminal.state.ptyId = 'pty-2'
        return { ok: true, handle: 'term-2', paneKey: REOPENED_PANE, ptyId: 'pty-2' }
      }
    )
    const head = seam.send(host, KEY, 'd1', 'one')
    const follower = seam.send(host, KEY, 'd2', 'two')
    resumed.resolve()
    expect(await head).toEqual(REOPENED)
    expect(await follower).toEqual({ outcome: 'accepted' })
    expect(terminal.writes).toEqual(['one', 'two'])
    expect(terminal.resumeAgentSessionInWorkspace).toHaveBeenCalledTimes(1)
  })

  it('refuses a reopened agent that never shows its composer, and links its pane', async () => {
    const { seam, host, terminal, reportSessions, link } = await started()
    reportSessions([{ paneKey: PANE, sessionId: SESSION.id }])
    terminal.exit()
    terminal.reopenable()
    terminal.waitForFreshWorkerComposer.mockResolvedValueOnce({
      handle: 'term-2',
      condition: 'tui-idle',
      satisfied: false,
      status: 'running',
      exitCode: null
    })
    expect(await seam.send(host, KEY, 'd1', 'x')).toEqual(UNREACHABLE)
    expect(terminal.writes).toEqual([])
    expect(link()).toEqual([expect.objectContaining({ paneKey: REOPENED_PANE })])
  })

  it('captures a persisted link’s changed session after connectors are turned off and on', async () => {
    const { seam, restart, host, terminal, reportSessions } = await started()
    seam.dispose('connectors_disabled')
    const restarted = restart()
    const changedSession = { ...SESSION, id: 'claude-session-after-clear' }
    terminal.state.rows = [sessionRow(PANE, null, changedSession)]
    reportSessions([{ paneKey: PANE, sessionId: changedSession.id }])
    terminal.exit()
    terminal.state.rows = []
    terminal.reopenable()
    expect(await restarted.send(host, KEY, 'after-restart', 'next')).toEqual(REOPENED)
    expect(terminal.resumeAgentSessionInWorkspace).toHaveBeenCalledWith(
      WORKTREE,
      expect.objectContaining({ providerSession: changedSession })
    )
  })
})
