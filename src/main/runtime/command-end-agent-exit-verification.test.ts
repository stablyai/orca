import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ShellForegroundProof } from '../providers/shell-foreground-proof'
import {
  endCommand,
  expectEveryReaderSawTheClear,
  expectNoReaderLostTheRow,
  launchAgentPane,
  liveRow,
  postHook,
  settle,
  shellPane,
  wireCommandEndHost,
  type CommandEndHost
} from './command-end-host-wiring.test-fixture'

// A command end (OSC 133;D) in a pane whose agent holds a live row asks the execution host whether
// that agent exited, every time, whatever launched it. A verified exit clears the row for every
// reader in one step; anything short of proof keeps it until the next command end asks again.
// A full-screen agent's nested shells leak their own 133;D, so the mark alone proves nothing.

const probe = vi.hoisted(() => vi.fn())
vi.mock('../../shared/agent-process-presence-probe', () => ({ probeAgentProcessPresence: probe }))

vi.mock('../git/worktree', () => {
  const worktrees = [
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/retirement-clear',
      isBare: false,
      isMainWorktree: false
    }
  ]
  return {
    listWorktrees: vi.fn().mockResolvedValue(worktrees),
    listWorktreesStrict: vi.fn().mockResolvedValue(worktrees)
  }
})

const hosts: CommandEndHost[] = []

afterEach(() => {
  probe.mockReset()
  for (const host of hosts.splice(0)) {
    host.teardown()
  }
  vi.restoreAllMocks()
})

async function wire(): Promise<CommandEndHost> {
  const host = await wireCommandEndHost()
  hosts.push(host)
  return host
}

const CLAUDE_PROCESS = {
  agentProcess: JSON.stringify({ pid: 4001, platform: process.platform, startTime: 'birth' })
}

async function claudeIsWorking(
  host: CommandEndHost,
  pane: { paneKey: string; launchToken?: string },
  extra: Record<string, unknown> = {}
): Promise<void> {
  await postHook(
    host.server,
    'claude',
    pane,
    { hook_event_name: 'UserPromptSubmit', session_id: 'claude-session', prompt: 'review the PR' },
    extra
  )
  expect(liveRow(host.server, pane.paneKey)?.state).toBe('working')
}

async function claudeIsDone(host: CommandEndHost, pane: { paneKey: string }): Promise<void> {
  await postHook(host.server, 'claude', pane, {
    hook_event_name: 'Stop',
    session_id: 'claude-session'
  })
  expect(liveRow(host.server, pane.paneKey)?.state).toBe('done')
}

const TAB = '11111111-1111-4111-8111-111111111111'
const LEAF = '22222222-2222-4222-8222-222222222222'

describe('a command end whose agent exit is verified clears the row for every reader', () => {
  for (const path of ['shell bytes', 'daemon fact'] as const) {
    const id = path.replace(' ', '-')

    it(`Orca-launched pane (${path})`, async () => {
      const host = await wire()
      const pane = await launchAgentPane(host, `pty-launched-${id}`)
      await claudeIsWorking(host, pane)
      host.readers.republishedWorktrees.length = 0

      await endCommand(host.runtime, pane.ptyId, path)

      expectEveryReaderSawTheClear(host.server, host.readers, pane.paneKey)
      // The shell outlived its agent, so the session stays resumable in place.
      const remnant = host.server.getStatusSnapshotForPane(pane.paneKey)
      expect(remnant).toHaveLength(1)
      expect(remnant[0]?.providerSessionOnly).toBe(true)
      expect(remnant[0]?.launchToken).toBeUndefined()
    })

    it(`restored pane whose authority came from a prior listing (${path})`, async () => {
      const host = await wire()
      const pane = shellPane(host.runtime, `pty-restored-${id}`, {
        tabId: TAB,
        leafId: LEAF,
        listingReceipt: true
      })
      await claudeIsWorking(host, pane)
      host.readers.republishedWorktrees.length = 0

      await endCommand(host.runtime, pane.ptyId, path)

      expectEveryReaderSawTheClear(host.server, host.readers, pane.paneKey)
    })

    it(`a pane the user typed the agent into, with no launch authority (${path})`, async () => {
      const host = await wire()
      const pane = shellPane(host.runtime, `pty-typed-${id}`, { tabId: TAB, leafId: LEAF })
      await claudeIsWorking(host, pane)
      host.readers.republishedWorktrees.length = 0

      await endCommand(host.runtime, pane.ptyId, path)

      expectEveryReaderSawTheClear(host.server, host.readers, pane.paneKey)
    })
  }

  it('a Done row is cleared too: an exited agent is not waiting for the user', async () => {
    const host = await wire()
    const pane = await launchAgentPane(host, 'pty-launched-done')
    await claudeIsWorking(host, pane)
    await claudeIsDone(host, pane)

    await endCommand(host.runtime, pane.ptyId, 'shell bytes')

    expectEveryReaderSawTheClear(host.server, host.readers, pane.paneKey)
  })

  it("Claude's own process gone clears the row even when the shell check cannot say", async () => {
    probe.mockResolvedValue('exited')
    const host = await wire()
    host.shellProof.mockResolvedValue('other')
    const pane = await launchAgentPane(host, 'pty-launched-presence')
    await claudeIsWorking(host, pane, CLAUDE_PROCESS)
    host.readers.republishedWorktrees.length = 0

    await endCommand(host.runtime, pane.ptyId, 'daemon fact')

    expect(probe).toHaveBeenCalled()
    expectEveryReaderSawTheClear(host.server, host.readers, pane.paneKey)
  })

  it("Claude's own process gone tells each reader once, without a second shell check", async () => {
    probe.mockResolvedValue('exited')
    const host = await wire()
    const pane = await launchAgentPane(host, 'pty-launched-presence-once')
    await claudeIsWorking(host, pane, CLAUDE_PROCESS)

    await endCommand(host.runtime, pane.ptyId, 'shell bytes')

    expect(host.readers.windowClears).toEqual([{ paneKey: pane.paneKey }])
    expect(host.readers.subscriberClears).toEqual([{ paneKey: pane.paneKey }])
  })

  it('a PTY exit clears every reader and keeps no resume identity', async () => {
    const host = await wire()
    const pane = await launchAgentPane(host, 'pty-launched-exit')
    await claudeIsWorking(host, pane)
    host.readers.republishedWorktrees.length = 0

    await host.runtime.onPtyExit(pane.ptyId, 0, `${pane.ptyId}-incarnation`)

    expectEveryReaderSawTheClear(host.server, host.readers, pane.paneKey)
    expect(host.server.getStatusSnapshotForPane(pane.paneKey)).toEqual([])
  })

  it('fences nothing: the next agent the user starts in that shell shows', async () => {
    const host = await wire()
    const pane = await launchAgentPane(host, 'pty-launched-next')
    await claudeIsWorking(host, pane)
    await endCommand(host.runtime, pane.ptyId, 'shell bytes')
    expect(liveRow(host.server, pane.paneKey)).toBeUndefined()

    await postHook(host.server, 'claude', pane, {
      hook_event_name: 'PreToolUse',
      session_id: 'next-session',
      tool_name: 'Bash'
    })

    expect(liveRow(host.server, pane.paneKey)?.state).toBe('working')
  })
})

describe('a command end that does not prove the agent exited keeps its row everywhere', () => {
  for (const path of ['shell bytes', 'daemon fact'] as const) {
    it(`a nested shell's leaked 133;D under a live TUI, then its real exit (${path})`, async () => {
      const host = await wire()
      const pane = await launchAgentPane(host, `pty-nested-${path.replace(' ', '-')}`)
      await claudeIsWorking(host, pane)
      await claudeIsDone(host, pane)
      // The full-screen agent still owns the foreground.
      host.shellProof.mockResolvedValue('other')

      await endCommand(host.runtime, pane.ptyId, path)

      expectNoReaderLostTheRow(host.server, host.readers, pane.paneKey, 'done')

      // The agent quits; its shell's prompt returns.
      host.shellProof.mockResolvedValue('shell')
      await endCommand(host.runtime, pane.ptyId, path)

      expectEveryReaderSawTheClear(host.server, host.readers, pane.paneKey)
    })
  }

  it('a live agent pid outranks a shell in the foreground (a suspended or nested agent)', async () => {
    probe.mockResolvedValue('live')
    const host = await wire()
    host.shellProof.mockResolvedValue('shell')
    const pane = await launchAgentPane(host, 'pty-live-pid')
    await claudeIsWorking(host, pane, CLAUDE_PROCESS)

    await endCommand(host.runtime, pane.ptyId, 'shell bytes')

    expectNoReaderLostTheRow(host.server, host.readers, pane.paneKey, 'working')
  })

  it('an unanswered check keeps the row and is asked again at the next command end', async () => {
    const host = await wire()
    host.shellProof.mockRejectedValueOnce(new Error('host unreachable'))
    const pane = await launchAgentPane(host, 'pty-unanswered')
    await claudeIsWorking(host, pane)

    await endCommand(host.runtime, pane.ptyId, 'daemon fact')
    expectNoReaderLostTheRow(host.server, host.readers, pane.paneKey, 'working')

    await endCommand(host.runtime, pane.ptyId, 'daemon fact')
    expectEveryReaderSawTheClear(host.server, host.readers, pane.paneKey)
  })

  for (const [answerProof, looks] of [
    // After a proven exit the rewritten row gets another look, which finds the new agent in front.
    ['shell', 2],
    // Where the host cannot tell, another look would answer the same: the new session is left alone.
    ['unprovable', 1]
  ] as const) {
    it(`a session that starts while the check is read keeps its row (${answerProof})`, async () => {
      const host = await wire()
      let answer: (proof: ShellForegroundProof) => void = () => {}
      host.shellProof.mockResolvedValue('other')
      host.shellProof.mockImplementationOnce(
        () => new Promise<ShellForegroundProof>((resolve) => (answer = resolve))
      )
      const pane = await launchAgentPane(host, `pty-next-session-${answerProof}`)
      await claudeIsWorking(host, pane)

      await endCommand(host.runtime, pane.ptyId, 'shell bytes')
      // The first agent exited; the user starts another before the slow read lands.
      await new Promise((resolve) => setTimeout(resolve, 2))
      await postHook(host.server, 'claude', pane, {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'second-session',
        prompt: 'a different task'
      })
      answer(answerProof)
      await settle()

      expect(liveRow(host.server, pane.paneKey)?.prompt).toBe('a different task')
      expect(host.readers.windowClears).toEqual([])
      expect(host.shellProof).toHaveBeenCalledTimes(looks)
    })
  }

  it('an agent without a session id gets a second look at its own late hook after a proven exit', async () => {
    const host = await wire()
    let answer: (proof: ShellForegroundProof) => void = () => {}
    host.shellProof.mockImplementationOnce(
      () => new Promise<ShellForegroundProof>((resolve) => (answer = resolve))
    )
    const pane = await launchAgentPane(host, 'pty-late-hook-no-session')
    await postHook(host.server, 'claude', pane, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'review the PR'
    })
    expect(liveRow(host.server, pane.paneKey)?.providerSession).toBeUndefined()

    await endCommand(host.runtime, pane.ptyId, 'shell bytes')
    await new Promise((resolve) => setTimeout(resolve, 2))
    await postHook(host.server, 'claude', pane, { hook_event_name: 'Stop' })
    answer('shell')
    await settle()

    expect(host.shellProof).toHaveBeenCalledTimes(2)
    expectEveryReaderSawTheClear(host.server, host.readers, pane.paneKey)
  })

  it("the exiting agent's own late hook mid-check gets a second look, which clears it", async () => {
    const host = await wire()
    let answer: (proof: ShellForegroundProof) => void = () => {}
    host.shellProof.mockImplementationOnce(
      () => new Promise<ShellForegroundProof>((resolve) => (answer = resolve))
    )
    const pane = await launchAgentPane(host, 'pty-late-own-hook')
    await claudeIsWorking(host, pane)

    await endCommand(host.runtime, pane.ptyId, 'shell bytes')
    await new Promise((resolve) => setTimeout(resolve, 2))
    await claudeIsDone(host, pane)
    answer('shell')
    await settle()

    expect(host.shellProof).toHaveBeenCalledTimes(2)
    expectEveryReaderSawTheClear(host.server, host.readers, pane.paneKey)
  })

  it('a command end that lands while a check is in flight is checked too', async () => {
    const host = await wire()
    let answer: (proof: ShellForegroundProof) => void = () => {}
    host.shellProof.mockImplementationOnce(
      () => new Promise<ShellForegroundProof>((resolve) => (answer = resolve))
    )
    const pane = await launchAgentPane(host, 'pty-in-flight')
    await claudeIsWorking(host, pane)

    // A leaked 133;D starts a check that sees the agent; the real exit lands before it answers.
    await endCommand(host.runtime, pane.ptyId, 'daemon fact')
    await endCommand(host.runtime, pane.ptyId, 'daemon fact')
    answer('other')
    await settle()

    expect(host.shellProof).toHaveBeenCalledTimes(2)
    expectEveryReaderSawTheClear(host.server, host.readers, pane.paneKey)
  })

  it('asks nothing for a shell whose panes hold no live row', async () => {
    const host = await wire()
    const pane = shellPane(host.runtime, 'pty-plain-shell', { tabId: TAB, leafId: LEAF })

    await endCommand(host.runtime, pane.ptyId, 'shell bytes')
    await endCommand(host.runtime, pane.ptyId, 'daemon fact')

    expect(host.shellProof).not.toHaveBeenCalled()
  })

  it('still drops launch authority at once: the token lives on in the shell', async () => {
    const host = await wire()
    host.shellProof.mockResolvedValue('other')
    const pane = await launchAgentPane(host, 'pty-authority')
    expect(host.runtime.readPaneLaunchAuthority(pane.paneKey)?.launchTokenHash).toBe(
      createHash('sha256').update(pane.launchToken).digest('hex')
    )

    host.runtime.emitDaemonPtyTransientFact(pane.ptyId, {
      kind: 'command-finished',
      exitCode: 0
    })

    expect(host.runtime.readPaneLaunchAuthority(pane.paneKey)).toEqual({ launchTokenHash: null })
  })
})

describe('a host that answers but cannot tell (WSL, Windows, no foreground evidence)', () => {
  it('leaves the command end as the evidence, as the desktop pane does', async () => {
    const host = await wire()
    host.shellProof.mockResolvedValue('unprovable')
    const pane = await launchAgentPane(host, 'pty-unprovable')
    await claudeIsWorking(host, pane)
    host.readers.republishedWorktrees.length = 0

    await endCommand(host.runtime, pane.ptyId, 'daemon fact')

    expectEveryReaderSawTheClear(host.server, host.readers, pane.paneKey)
  })

  it('still keeps an agent whose own process the host proves alive', async () => {
    probe.mockResolvedValue('live')
    const host = await wire()
    host.shellProof.mockResolvedValue('unprovable')
    const pane = await launchAgentPane(host, 'pty-unprovable-live-pid')
    await claudeIsWorking(host, pane, CLAUDE_PROCESS)

    await endCommand(host.runtime, pane.ptyId, 'shell bytes')

    expectNoReaderLostTheRow(host.server, host.readers, pane.paneKey, 'working')
  })
})

describe('an SSH pane after a verified exit', () => {
  it("does not come back when a reconnecting relay replays the agent's cached status", async () => {
    const host = await wire()
    const pane = shellPane(host.runtime, 'pty-ssh-replay', {
      tabId: TAB,
      leafId: LEAF,
      connectionId: 'conn-1'
    })
    await claudeIsWorking(host, pane)
    await endCommand(host.runtime, pane.ptyId, 'shell bytes')
    expect(liveRow(host.server, pane.paneKey)).toBeUndefined()

    host.server.ingestRemote(
      {
        paneKey: pane.paneKey,
        tabId: TAB,
        worktreeId: 'wt-1',
        source: 'claude',
        hookEventName: 'UserPromptSubmit',
        isReplay: true,
        providerSession: { key: 'session_id', id: 'claude-session' },
        payload: { state: 'working', prompt: 'review the PR', agentType: 'claude' }
      },
      'conn-1'
    )

    expect(liveRow(host.server, pane.paneKey)).toBeUndefined()
  })
})

describe('an answer that could not be read', () => {
  it('is asked again shortly, without waiting for another command end', async () => {
    const host = await wire()
    host.shellProof.mockResolvedValueOnce('unread')
    const pane = await launchAgentPane(host, 'pty-unread-reask')
    await claudeIsWorking(host, pane)

    await endCommand(host.runtime, pane.ptyId, 'daemon fact')
    expectNoReaderLostTheRow(host.server, host.readers, pane.paneKey, 'working')

    await vi.waitFor(() => expectEveryReaderSawTheClear(host.server, host.readers, pane.paneKey), {
      timeout: 2_000,
      interval: 50
    })
    expect(host.shellProof).toHaveBeenCalledTimes(2)
  })

  it('is asked a bounded number of times, then waits for the next command end', async () => {
    const host = await wire()
    host.shellProof.mockResolvedValue('unread')
    const pane = await launchAgentPane(host, 'pty-unread-bounded')
    await claudeIsWorking(host, pane)

    await endCommand(host.runtime, pane.ptyId, 'daemon fact')
    await new Promise((resolve) => setTimeout(resolve, 2_400))

    expect(host.shellProof).toHaveBeenCalledTimes(3)
    expectNoReaderLostTheRow(host.server, host.readers, pane.paneKey, 'working')
  })

  it('is not asked again once something else is proven in front', async () => {
    const host = await wire()
    host.shellProof.mockResolvedValue('other')
    const pane = await launchAgentPane(host, 'pty-other-no-reask')
    await claudeIsWorking(host, pane)

    await endCommand(host.runtime, pane.ptyId, 'daemon fact')
    await new Promise((resolve) => setTimeout(resolve, 800))

    expect(host.shellProof).toHaveBeenCalledTimes(1)
  })

  it('leaves no re-ask behind once the PTY exits', async () => {
    const host = await wire()
    host.shellProof.mockResolvedValue('unread')
    const pane = await launchAgentPane(host, 'pty-unread-exit')
    await claudeIsWorking(host, pane)

    await endCommand(host.runtime, pane.ptyId, 'daemon fact')
    await host.runtime.onPtyExit(pane.ptyId, 0, `${pane.ptyId}-incarnation`)
    await new Promise((resolve) => setTimeout(resolve, 800))

    expect(host.shellProof).toHaveBeenCalledTimes(1)
  })
})
