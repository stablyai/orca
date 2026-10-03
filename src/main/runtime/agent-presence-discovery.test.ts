import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { AgentProcessPresence } from '../../shared/agent-process-presence'
import { makePaneKey } from '../../shared/stable-pane-id'

const leafId = '11111111-1111-4111-8111-111111111111'
const paneKey = makePaneKey('tab', leafId)
const owner = {
  agent: 'codex',
  process: { pid: 42, platform: 'linux', startTime: 'boot:42' }
} as const
const runtimes: OrcaRuntimeService[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) {
    runtime.setPtyController(null)
  }
  vi.useRealTimers()
})
function fixture() {
  const publish = vi.fn()
  const capture = vi.fn<() => Promise<AgentProcessPresence | undefined>>().mockResolvedValue(owner)
  let rows: AgentStatusIpcPayload[] = []
  const runtime = new OrcaRuntimeService(null, undefined, {
    onForegroundAgentPresence: publish,
    getAgentProviderSessionRowsForPane: () => rows,
    getAgentOwner: (key: string) => {
      const row = rows.find((entry) => entry.paneKey === key && entry.agentPresence)
      return row?.agentPresence
        ? { paneKey: key, connectionId: null, presence: row.agentPresence, receivedAt: 1 }
        : undefined
    }
  })
  runtimes.push(runtime)
  const controller = {
    write: () => true,
    kill: () => true,
    captureAgentPresence: capture,
    getForegroundProcess: async () => null
  }
  runtime.setPtyController(controller)
  runtime.registerPty('pty', 'folder', null, { tabId: 'tab', leafId })
  const data = (value: string) => runtime.onPtyData('pty', value, Date.now())
  return {
    runtime,
    capture,
    publish,
    controller,
    data,
    setRows: (value: AgentStatusIpcPayload[]) => {
      rows = value
    }
  }
}

describe('runtime foreground admission', () => {
  it('makes one read per long command and none for idle shells or completed commands', async () => {
    vi.useFakeTimers()
    const f = fixture()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.capture).not.toHaveBeenCalled()
    f.data('\x1b]133;C\x07')
    f.data('\x1b]133;C\x07')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(f.capture).toHaveBeenCalledTimes(1)
    expect(f.publish).toHaveBeenCalledWith(expect.objectContaining({ paneKey }), owner)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.capture).toHaveBeenCalledTimes(1)
    f.data('\x1b]133;D;0\x07\x1b]133;C\x07\x1b]133;D;0\x07')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(f.capture).toHaveBeenCalledTimes(1)
  })

  it('lets a command-start doubt an owner, while owner-explained evidence costs nothing', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.setRows([
      {
        paneKey,
        tabId: 'tab',
        worktreeId: 'folder',
        connectionId: null,
        state: 'done',
        prompt: '',
        receivedAt: 1,
        stateStartedAt: 1,
        agentPresence: owner
      }
    ])
    f.runtime.observeAgentPresenceEvidence(paneKey, 'codex')
    f.data('\x1b]0;⠋ Codex\x07')
    await vi.advanceTimersByTimeAsync(10)
    expect(f.capture).not.toHaveBeenCalled()
    // A shell running commands proves the owner is not in front (Ctrl-Z, then another agent).
    f.data('\x1b]133;C\x07')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(f.capture).toHaveBeenCalledTimes(1)
  })

  it.each(['command end', 'controller replacement', 'terminal release'])(
    'discards pending capture after %s',
    async (reason) => {
      vi.useFakeTimers()
      const f = fixture()
      let finish!: (presence: AgentProcessPresence) => void
      f.capture.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      f.data('\x1b]133;C\x07')
      await vi.advanceTimersByTimeAsync(1_000)
      expect(f.capture).toHaveBeenCalledTimes(1)
      if (reason === 'command end') {
        f.data('\x1b]133;D;0\x07')
      } else if (reason === 'controller replacement') {
        f.runtime.setPtyController({ ...f.controller })
      } else {
        f.runtime.onPtyExit('pty', 0)
      }
      finish(owner)
      await vi.advanceTimersByTimeAsync(1)
      expect(f.publish).not.toHaveBeenCalled()
    }
  )

  it('keeps WSL and remote discovery on their execution-host boundary', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.runtime.registerPty('wsl', 'folder', null, { tabId: 'wsl', leafId }, true)
    f.runtime.registerPty('ssh', 'folder', 'connection', { tabId: 'ssh', leafId })
    for (const id of ['wsl', 'ssh']) {
      f.runtime.onPtyData(id, '\x1b]133;C\x07', Date.now())
    }
    await vi.advanceTimersByTimeAsync(2_000)
    expect(f.capture).not.toHaveBeenCalled()
  })

  it('re-derives a surviving owner with one read when a terminal is reattached', async () => {
    const f = fixture()
    const reattachedLeaf = '22222222-2222-4222-8222-222222222222'
    f.runtime.registerPty('reattached', 'folder', null, {
      tabId: 'tab-2',
      leafId: reattachedLeaf,
      reattached: true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(f.capture).toHaveBeenCalledExactlyOnceWith(
      'reattached',
      expect.objectContaining({ snapshotNotBeforeMs: expect.any(Number) })
    )
    expect(f.publish).toHaveBeenCalledWith(
      expect.objectContaining({ paneKey: makePaneKey('tab-2', reattachedLeaf) }),
      owner
    )
  })

  it('bounds hook reads per command and agent, so a pane that never admits an owner stays cheap', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.capture.mockResolvedValue(undefined)
    f.data('\x1b]133;C\x07')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(f.capture).toHaveBeenCalledTimes(1)
    // 30 hooks over 6 s: the first read misses, so the next waits 5 s.
    for (let i = 0; i < 30; i += 1) {
      f.runtime.observeAgentPresenceEvidence(paneKey, 'claude')
      await vi.advanceTimersByTimeAsync(200)
    }
    expect(f.capture).toHaveBeenCalledTimes(3)
    f.runtime.observeAgentPresenceEvidence(paneKey, 'codex')
    await vi.advanceTimersByTimeAsync(10)
    expect(f.capture).toHaveBeenCalledTimes(4)
    f.data('\x1b]133;D;0\x07\x1b]133;C\x07')
    f.runtime.observeAgentPresenceEvidence(paneKey, 'claude')
    await vi.advanceTimersByTimeAsync(10)
    expect(f.capture).toHaveBeenCalledTimes(5)
  })

  it.each([
    ['⠋ Codex', 'codex'],
    ['✳ Claude Code', 'claude'],
    ['Cursor Agent', 'cursor'],
    ['π ⠋ my-session', 'pi']
  ])('reads once when a title names an agent (%s)', async (title) => {
    vi.useFakeTimers()
    const f = fixture()
    for (let i = 0; i < 5; i += 1) {
      f.data(`\x1b]0;${title}\x07`)
      f.data('\x1b]0;zsh\x07')
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(f.capture).toHaveBeenCalledTimes(1)
  })

  it('reads a launched pane after its own command-start even when the shell starts slowly', async () => {
    vi.useFakeTimers()
    const f = fixture()
    let agentRunning = false
    f.capture.mockImplementation(async () => (agentRunning ? owner : undefined))
    const launchedLeaf = '33333333-3333-4333-8333-333333333333'
    f.runtime.registerPty('launched', 'folder', null, {
      tabId: 'tab-3',
      leafId: launchedLeaf,
      incarnationId: 'launch-1',
      agentLaunchAuthority: { launchToken: 'launch-token', launchAgent: 'codex' }
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(f.capture).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(200)
    f.runtime.onPtyData('launched', '\x1b]133;A\x07\x1b]133;C\x07', Date.now())
    agentRunning = true
    await vi.advanceTimersByTimeAsync(1_000)
    expect(f.capture).toHaveBeenCalledTimes(2)
    expect(f.publish).toHaveBeenCalledWith(
      expect.objectContaining({ paneKey: makePaneKey('tab-3', launchedLeaf) }),
      owner
    )
  })

  it('bounds production reads: idle zero, one per command lasting a second, none per marker', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.capture.mockResolvedValue(undefined)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.capture).not.toHaveBeenCalled()
    for (let i = 0; i < 25; i += 1) {
      f.data('\x1b]133;C\x07')
      f.data('\x1b]133;C\x07')
      await vi.advanceTimersByTimeAsync(i % 2 === 0 ? 2_000 : 300)
      f.data('\x1b]133;D;0\x07')
    }
    await vi.advanceTimersByTimeAsync(60_000)
    // 13 of the 25 commands ran past the one-second mark; markers and idle time add nothing.
    expect(f.capture).toHaveBeenCalledTimes(13)
  })

  it('asks for a process table that began no earlier than the evidence it answers', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(50_000)
    const f = fixture()
    f.capture.mockResolvedValue(undefined)
    f.data('\x1b]133;C\x07')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(f.capture).toHaveBeenLastCalledWith(
      'pty',
      expect.objectContaining({ snapshotNotBeforeMs: 50_000 })
    )
    vi.setSystemTime(60_000)
    f.runtime.observeAgentPresenceEvidence(paneKey, 'claude')
    await vi.advanceTimersByTimeAsync(1)
    expect(f.capture).toHaveBeenLastCalledWith(
      'pty',
      expect.objectContaining({ snapshotNotBeforeMs: 60_000 })
    )
  })

  it('reads for a newer command instead of joining a read still waiting on an older one', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.capture.mockImplementation(() => new Promise(() => undefined))
    f.data('\x1b]133;C\x07')
    await vi.advanceTimersByTimeAsync(1_000)
    f.data('\x1b]133;D;0\x07\x1b]133;C\x07')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(f.capture).toHaveBeenCalledTimes(2)
  })
})
