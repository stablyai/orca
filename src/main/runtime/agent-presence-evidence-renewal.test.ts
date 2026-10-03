import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { AgentPaneOwner, AgentProcessPresence } from '../../shared/agent-process-presence'
import { makePaneKey } from '../../shared/stable-pane-id'

const leafId = '11111111-1111-4111-8111-111111111111'
const paneKey = makePaneKey('tab', leafId)
const claude = {
  agent: 'claude',
  process: { pid: 42, platform: 'linux', startTime: 'boot:42' }
} as const
const claudeAgain = {
  agent: 'claude',
  process: { pid: 77, platform: 'linux', startTime: 'boot:77' }
} as const
const runtimes: OrcaRuntimeService[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) {
    runtime.setPtyController(null)
  }
  vi.useRealTimers()
})

/** A pane with no OSC 133 command marks (fish, a nested shell): only evidence can buy reads. */
function fixture() {
  const owners = new Map<string, AgentPaneOwner>()
  const publish = vi.fn(async (scope: { paneKey: string }, presence: AgentProcessPresence) => {
    owners.set(scope.paneKey, {
      paneKey: scope.paneKey,
      connectionId: null,
      presence,
      receivedAt: Date.now()
    })
  })
  let foreground: AgentProcessPresence | undefined
  const capture = vi.fn(async () => foreground)
  const runtime = new OrcaRuntimeService(null, undefined, {
    onForegroundAgentPresence: publish,
    getAgentProviderSessionRowsForPane: () => [],
    getAgentOwner: (key: string) => owners.get(key)
  })
  runtimes.push(runtime)
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    captureAgentPresence: capture,
    getForegroundProcess: async () => null
  })
  return {
    runtime,
    capture,
    publish,
    setForeground: (value: AgentProcessPresence | undefined) => {
      foreground = value
    },
    endOwner: (key: string) => {
      const owner = owners.get(key)
      if (owner) {
        owners.set(key, { ...owner, presence: { ...owner.presence, ended: true } })
      }
    }
  }
}

async function claudeEvidence(
  f: ReturnType<typeof fixture>,
  ptyId: string,
  key: string,
  seconds: number
): Promise<void> {
  for (let i = 0; i < seconds; i += 1) {
    f.runtime.observeAgentPresenceEvidence(key, 'claude')
    f.runtime.onPtyData(ptyId, '\x1b]0;✳ Claude Code\x07', Date.now())
    f.runtime.onPtyData(ptyId, '\x1b]0;fish\x07', Date.now())
    await vi.advanceTimersByTimeAsync(1_000)
  }
}

describe('evidence reads in panes without command marks', () => {
  it('reads a second run of the same agent once the first owner has ended', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.runtime.registerPty('pty', 'folder', null, { tabId: 'tab', leafId })
    f.setForeground(claude)
    await claudeEvidence(f, 'pty', paneKey, 10)
    expect(f.capture).toHaveBeenCalledTimes(1)
    f.endOwner(paneKey)
    f.setForeground(claudeAgain)
    await claudeEvidence(f, 'pty', paneKey, 10)
    expect(f.capture).toHaveBeenCalledTimes(2)
    expect(f.publish).toHaveBeenLastCalledWith(expect.objectContaining({ paneKey }), claudeAgain)
  })

  it('publishes an Orca-launched agent whose launch read ran before the agent existed', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const launchedLeaf = '33333333-3333-4333-8333-333333333333'
    const launchedKey = makePaneKey('tab-3', launchedLeaf)
    f.runtime.registerPty('launched', 'folder', null, {
      tabId: 'tab-3',
      leafId: launchedLeaf,
      incarnationId: 'launch-1',
      agentLaunchAuthority: { launchToken: 'launch-token', launchAgent: 'claude' }
    })
    await vi.advanceTimersByTimeAsync(3_000)
    expect(f.capture).toHaveBeenCalledTimes(1)
    f.setForeground(claude)
    await claudeEvidence(f, 'launched', launchedKey, 5)
    expect(f.publish).toHaveBeenCalledWith(
      expect.objectContaining({ paneKey: launchedKey }),
      claude
    )
  })

  it('keeps a hook storm on a pane that never yields an owner to a handful of reads', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.runtime.registerPty('pty', 'folder', null, { tabId: 'tab', leafId })
    for (let i = 0; i < 300; i += 1) {
      f.runtime.observeAgentPresenceEvidence(paneKey, 'claude')
      await vi.advanceTimersByTimeAsync(200)
    }
    // 60 s of hooks every 200 ms: misses back off 5 s, 10 s, 20 s, 40 s.
    expect(f.capture.mock.calls.length).toBeLessThanOrEqual(4)
    expect(f.capture.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('reads a new run of a backed-off agent at once instead of waiting out the backoff', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.runtime.registerPty('pty', 'folder', null, { tabId: 'tab', leafId })
    // tmux hid the first run: its session's hooks keep missing and back off.
    for (let i = 0; i < 100; i += 1) {
      f.runtime.observeAgentPresenceEvidence(paneKey, 'claude', false, { sessionId: 'a' })
      await vi.advanceTimersByTimeAsync(200)
    }
    const misses = f.capture.mock.calls.length
    expect(misses).toBe(3)
    // Detached from tmux, the same agent starts again: its session start is read immediately.
    f.setForeground(claudeAgain)
    f.runtime.observeAgentPresenceEvidence(paneKey, 'claude', false, {
      sessionId: 'b',
      started: true
    })
    await vi.advanceTimersByTimeAsync(10)
    expect(f.capture).toHaveBeenCalledTimes(misses + 1)
    expect(f.publish).toHaveBeenLastCalledWith(expect.objectContaining({ paneKey }), claudeAgain)
  })

  it('costs no read for evidence an existing owner explains, however often it arrives', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.runtime.registerPty('pty', 'folder', null, { tabId: 'tab', leafId })
    f.setForeground(claude)
    f.runtime.observeAgentPresenceEvidence(paneKey, 'claude')
    await vi.advanceTimersByTimeAsync(10)
    for (let i = 0; i < 300; i += 1) {
      f.runtime.observeAgentPresenceEvidence(paneKey, 'claude')
      await vi.advanceTimersByTimeAsync(200)
    }
    expect(f.capture).toHaveBeenCalledTimes(1)
  })
})
