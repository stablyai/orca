import { afterEach, describe, expect, it, vi } from 'vitest'
import { A, B, PTY, WT, flush, makeAgentExitHost } from './agent-exit-host.test-fixture'
import { makeHeadlessTerminalLayout } from './orca-runtime-test-fixtures.spec'

const CLAUDE = { pid: 4242, platform: 'darwin' as const, startTime: 'utc:claude-start' }

afterEach(() => {
  vi.useRealTimers()
})

describe('F2: a proven agent run exit retires the chat it was shown in (headless)', () => {
  it("consumes the canonical owner's own end even though a presence probe would say null (R1A-1)", async () => {
    const host = makeAgentExitHost({ viewMode: 'chat', leaves: 1, tabLaunchAgent: 'claude' })
    await host.published()
    host.owner(A, { agent: 'claude', process: CLAUDE })
    const writes = host.writeCount()
    const version = host.snapshotVersion()!

    // Claude /exit: its process-ending SessionEnd marks the owner ended; the shell is in front.
    host.owner(A, { agent: 'claude', process: CLAUDE, ended: true })
    await flush()

    expect(host.hostPair()).toEqual({ viewMode: 'terminal', owner: undefined })
    expect(host.hostLaunchAgent()).toBeUndefined()
    // R1C-3: one session write and one snapshot bump for the whole retirement.
    expect(host.writeCount()).toBe(writes + 1)
    expect(host.snapshotVersion()).toBe(version + 1)
    expect(host.probe).not.toHaveBeenCalled()
  })

  it('learns a Codex run from one fenced capture and proves its exit by PID, with no exit hook', async () => {
    const host = makeAgentExitHost({ leaves: 1, tabLaunchAgent: 'codex' })
    host.foreground.set(PTY[A]!, { name: 'codex', pid: 5151, startTime: 'codex-start' })
    host.alive.add(5151)
    await host.published()
    host.owner(A, { agent: 'codex' })
    await flush()
    expect(host.bootstrap).toHaveBeenCalledWith(
      expect.objectContaining({ pid: 5151, startTime: 'codex-start' })
    )

    // Codex quits to its shell; the title exit is only a reason to look.
    host.alive.delete(5151)
    host.foreground.set(PTY[A]!, null)
    host.runtime['confirmPtyAgentExit'](PTY[A]!)
    await vi.waitFor(() => expect(host.hostLaunchAgent()).toBeUndefined())
    // An unswitched tab keeps its view unset; the cleared hint turns the phone to terminal.
    expect(host.hostPair().viewMode).toBeUndefined()
    const rows = await host.published()
    expect(rows.map((row) => [row.viewMode, row.launchAgent])).toEqual([[undefined, undefined]])
  })

  it('adopts a same-name replacement already in front instead of retiring for it (R4.1-1)', async () => {
    const host = makeAgentExitHost({ viewMode: 'chat', leaves: 1 })
    host.foreground.set(PTY[A]!, { name: 'codex', pid: 1001, startTime: 'a' })
    host.alive.add(1001)
    await host.published()
    host.owner(A, { agent: 'codex' })
    await flush()
    // A exits and B (also codex) is already running before A's result resolves; no hook, no title.
    host.alive.delete(1001)
    host.foreground.set(PTY[A]!, { name: 'codex', pid: 2002, startTime: 'b' })
    host.alive.add(2002)
    host.runtime['confirmPtyAgentExit'](PTY[A]!)
    await vi.waitFor(() =>
      expect(host.runtime['agentExitRuns'].current(PTY[A]!)?.identity?.pid).toBe(2002)
    )
    expect(host.hostPair()).toEqual({ viewMode: 'chat', owner: undefined })
  })

  it("never retires for B when A's old end arrives after B became the owner (R1A-4)", async () => {
    const host = makeAgentExitHost({ viewMode: 'chat', leaves: 1 })
    await host.published()
    host.owner(A, { agent: 'claude', process: CLAUDE })
    host.owner(A, { agent: 'claude', process: { ...CLAUDE, pid: 777, startTime: 'b' } })
    // A replayed/late end for the old process is not this run's end.
    host.inspectProcess.mockClear()
    host.owner(A, { agent: 'claude', process: CLAUDE, ended: true })
    await flush()
    expect(host.inspectProcess).not.toHaveBeenCalled()
    expect(host.hostPair()).toEqual({ viewMode: 'chat', owner: undefined })
  })

  it('leaves the end unproven while the ended process is still in front, then confirms it', async () => {
    const host = makeAgentExitHost({ viewMode: 'chat', leaves: 1 })
    await host.published()
    host.owner(A, { agent: 'claude', process: CLAUDE })
    // The SessionEnd hook can precede the process leaving the pane.
    host.foreground.set(PTY[A]!, { name: 'claude', pid: CLAUDE.pid, startTime: 'raw' })
    host.owner(A, { agent: 'claude', process: CLAUDE, ended: true })
    await flush()
    expect(host.hostPair().viewMode).toBe('chat')
    host.foreground.set(PTY[A]!, null)
    host.runtime['confirmPtyAgentExit'](PTY[A]!)
    await vi.waitFor(() => expect(host.hostPair().viewMode).toBe('terminal'))
  })

  it('ignores an exit on a pane that is not the chat owner', async () => {
    const host = makeAgentExitHost({ viewMode: 'chat', leaves: 2, chatLeafId: B })
    await host.published()
    host.owner(A, { agent: 'claude', process: CLAUDE })
    host.owner(A, { agent: 'claude', process: CLAUDE, ended: true })
    await flush()
    expect(host.hostPair()).toEqual({ viewMode: 'chat', owner: B })
  })

  it('runs no probe, capture or remote scan for an SSH pane, whatever happens (R1E-1)', async () => {
    const host = makeAgentExitHost({ viewMode: 'chat', leaves: 1, connectionId: 'ssh-win' })
    await host.published()
    host.owner(A, { agent: 'codex' })
    for (let index = 0; index < 5; index += 1) {
      host.runtime['confirmPtyAgentExit'](PTY[A]!)
      host.runtime['noteNativeChatAgentEvidence'](PTY[A]!)
    }
    await flush()
    expect(host.inspectProcess).not.toHaveBeenCalled()
    expect(host.probe).not.toHaveBeenCalled()
  })

  it('starts no probe for 1,000 unchanged-owner status updates (R1E-2)', async () => {
    const host = makeAgentExitHost({ viewMode: 'chat', leaves: 1 })
    await host.published()
    host.owner(A, { agent: 'claude', process: CLAUDE })
    host.alive.add(CLAUDE.pid)
    await flush()
    host.probe.mockClear()
    host.inspectProcess.mockClear()
    for (let index = 0; index < 1_000; index += 1) {
      host.owner(A, { agent: 'claude', process: CLAUDE })
    }
    await flush()
    expect(host.probe).not.toHaveBeenCalled()
    expect(host.inspectProcess).not.toHaveBeenCalled()
  })

  it('stops discovery after three captures on a pane whose agent never shows (R1E-3)', async () => {
    vi.useFakeTimers()
    const host = makeAgentExitHost({ viewMode: 'chat', leaves: 1, tabLaunchAgent: 'codex' })
    await host.published()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(host.inspectProcess.mock.calls.length).toBeLessThanOrEqual(3)
    expect(host.probe).not.toHaveBeenCalled()
  })

  it('finds a silent exit of a known agent with one targeted probe per 15 s, no table scan', async () => {
    vi.useFakeTimers()
    const host = makeAgentExitHost({ viewMode: 'chat', leaves: 1 })
    await host.published()
    host.owner(A, { agent: 'claude', process: CLAUDE })
    host.alive.add(CLAUDE.pid)
    await vi.advanceTimersByTimeAsync(6_000)
    host.inspectProcess.mockClear()
    host.probe.mockClear()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(host.probe.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(host.probe.mock.calls.length).toBeLessThanOrEqual(4)
    expect(host.inspectProcess).not.toHaveBeenCalled()
    // The agent crashes without any title or hook; the next fallback finds it.
    host.alive.delete(CLAUDE.pid)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(host.hostPair().viewMode).toBe('terminal')
    // Nothing left to watch: no further timer work.
    const probes = host.probe.mock.calls.length
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(host.probe.mock.calls.length).toBe(probes)
  })
})

describe('F2: composer admission follows the committed presentation (headless)', () => {
  it('refuses a stale tagged send with zero bytes after the retirement; raw input still writes', async () => {
    const host = makeAgentExitHost({ viewMode: 'chat', leaves: 1 })
    await host.published()
    host.owner(A, { agent: 'claude', process: CLAUDE })
    host.owner(A, { agent: 'claude', process: CLAUDE, ended: true })
    await flush()
    host.write.mockClear()

    await expect(host.chatSend(A, 'after-exit')).resolves.toMatchObject({
      accepted: false,
      bytesWritten: 0,
      refusedReason: 'agent-exited'
    })
    expect(host.write).not.toHaveBeenCalled()
    await expect(host.rawSend(A, 'ls')).resolves.toMatchObject({ accepted: true })
    expect(host.write).toHaveBeenCalled()
  })

  it('admits a new action as soon as the user switches back to chat; the refused one stays refused (R1B-1)', async () => {
    const host = makeAgentExitHost({ viewMode: 'terminal', leaves: 1 })
    await host.published()
    await expect(host.chatSend(A, 'old')).resolves.toMatchObject({ accepted: false })
    await host.runtime.setMobileSessionTabProps(`id:${WT}`, { tabId: 'host-tab', viewMode: 'chat' })
    await expect(host.chatSend(A, 'new')).resolves.toMatchObject({ accepted: true })
    await expect(host.chatSend(A, 'old')).resolves.toMatchObject({
      accepted: false,
      bytesWritten: 0
    })
  })

  it('admits a sole unswitched pane with a supported hint and refuses it once the hint is retired', async () => {
    const host = makeAgentExitHost({ leaves: 1, tabLaunchAgent: 'claude' })
    await host.published()
    await expect(host.chatSend(A, 'legacy')).resolves.toMatchObject({ accepted: true })
    host.owner(A, { agent: 'claude', process: CLAUDE })
    host.owner(A, { agent: 'claude', process: CLAUDE, ended: true })
    await flush()
    await expect(host.chatSend(A, 'legacy-2')).resolves.toMatchObject({
      accepted: false,
      bytesWritten: 0
    })
  })
})

describe('R2: only an intent, a launch or this pane rebinding orders after an exit (headless)', () => {
  const layoutPush = (host: ReturnType<typeof makeAgentExitHost>, title: string) =>
    host.runtime.updateMobileSessionPaneLayout(`id:${WT}`, {
      tabId: 'host-tab',
      root: makeHeadlessTerminalLayout({ [A]: PTY[A], [B]: PTY[B] }).root,
      expandedLeafId: null,
      titlesByLeafId: { [A]: title, [B]: 'zsh' }
    })

  it('retires after a title-only layout push between the end hook and the confirming look (R2-1)', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 1_000 })
    const host = makeAgentExitHost({ viewMode: 'chat', leaves: 2, chatLeafId: A })
    await host.published()
    host.owner(A, { agent: 'claude', process: CLAUDE })
    // SessionEnd lands before the process leaves the pane: the end is reopened, not proven.
    vi.setSystemTime(2_000)
    host.foreground.set(PTY[A]!, { name: 'claude', pid: CLAUDE.pid, startTime: 'raw' })
    host.owner(A, { agent: 'claude', process: CLAUDE, ended: true })
    await flush()
    vi.setSystemTime(3_000)
    await layoutPush(host, 'zsh')
    host.foreground.set(PTY[A]!, null)
    host.runtime['confirmPtyAgentExit'](PTY[A]!)
    await vi.waitFor(() =>
      expect(host.hostPair()).toEqual({ viewMode: 'terminal', owner: undefined })
    )
  })

  it("keeps an in-flight composer action through a layout push or a sibling's change (R2-9)", async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 1_000 })
    const host = makeAgentExitHost({ viewMode: 'chat', leaves: 2, chatLeafId: A })
    await host.published()
    await expect(host.chatSend(A, 'action-1', 'hello')).resolves.toMatchObject({ accepted: true })
    vi.setSystemTime(2_000)
    await layoutPush(host, 'claude working')
    // The same action's next step (its Enter after a paste delay) still lands on the live agent.
    await expect(host.chatSend(A, 'action-1', '')).resolves.toMatchObject({ accepted: true })
  })

  it("republishes a client's same-value switch so paired clients fence with its token", async () => {
    const host = makeAgentExitHost({ viewMode: 'chat', leaves: 1 })
    await host.published()
    const stored = () => {
      const tab = host.runtime['mobileSessionTabsByWorktree'].get(WT)?.tabs[0]
      return tab?.type === 'terminal' ? tab.presentationToken : undefined
    }
    const before = stored()
    await host.runtime.setMobileSessionTabProps(`id:${WT}`, { tabId: 'host-tab', viewMode: 'chat' })
    const after = stored()
    expect(before).toBeDefined()
    expect(after).not.toBe(before)
  })

  it('still lets a client switch back to chat after the exit win over it', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 1_000 })
    const host = makeAgentExitHost({ viewMode: 'chat', leaves: 1 })
    await host.published()
    host.owner(A, { agent: 'claude', process: CLAUDE })
    vi.setSystemTime(2_000)
    host.foreground.set(PTY[A]!, { name: 'claude', pid: CLAUDE.pid, startTime: 'raw' })
    host.owner(A, { agent: 'claude', process: CLAUDE, ended: true })
    await flush()
    vi.setSystemTime(3_000)
    await host.runtime.setMobileSessionTabProps(`id:${WT}`, { tabId: 'host-tab', viewMode: 'chat' })
    host.foreground.set(PTY[A]!, null)
    host.runtime['confirmPtyAgentExit'](PTY[A]!)
    await flush()
    await flush()
    expect(host.hostPair().viewMode).toBe('chat')
  })
})
