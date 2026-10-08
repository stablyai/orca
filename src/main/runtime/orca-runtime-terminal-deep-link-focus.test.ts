import './orca-runtime-test-lifecycle.spec'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import { TEST_WORKTREE_ID, TEST_WORKTREE_PATH, store } from './orca-runtime-test-fixtures.spec'
import { deriveRemoteRuntimeTerminalCreateHandle } from './remote-runtime-terminal-create-identity'
import { deterministicAgentSessionUuid } from './runtime-agent-launch-resolution'
import { parseTerminalDeepLink } from '../../shared/terminal-deep-link'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'
import { TerminalDeepLinkState } from '../startup/terminal-deep-link-state'

const FOCUS_ONLY_NOTIFIER_METHODS = new Set(['focusTerminal', 'revealTerminalSession'])

// Records every notifier call so a test can prove the link reached no create/send/activate/file path.
function recordingNotifier(): {
  notifier: Parameters<InstanceType<typeof OrcaRuntimeService>['setNotifier']>[0]
  calls: string[]
  revealTerminalSession: ReturnType<typeof vi.fn>
  focusTerminal: ReturnType<typeof vi.fn>
} {
  const calls: string[] = []
  const revealTerminalSession = vi.fn(async () => ({ tabId: 'tab-revealed' }))
  const focusTerminal = vi.fn()
  const methods: Record<string, unknown> = { revealTerminalSession, focusTerminal }
  const notifier = new Proxy(methods, {
    get(target, property) {
      if (typeof property !== 'string' || property === 'then') {
        return undefined
      }
      return (...args: unknown[]) => {
        calls.push(property)
        const method = target[property]
        return typeof method === 'function' ? method(...args) : undefined
      }
    }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the proxy answers every notifier member with a recording function.
  return { notifier: notifier as never, calls, revealTerminalSession, focusTerminal }
}

function ptyController(
  spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' }),
  livePtyIds: ReadonlySet<string> = new Set(['pty-bg']),
  providerStartup: Promise<void> = Promise.resolve()
) {
  return {
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    // Mirrors the desktop controller: the sync probe cannot answer before startup settles.
    hasPty: () => null,
    probePtyLiveness: async (ptyId: string) => {
      await providerStartup
      return livePtyIds.has(ptyId)
    }
  }
}

function syncSingleLeaf(runtime: InstanceType<typeof OrcaRuntimeService>, ptyId: string | null) {
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: 'tab-leaf',
        worktreeId: TEST_WORKTREE_ID,
        title: 'agent',
        activeLeafId: 'pane:1',
        layout: null
      }
    ],
    leaves: [
      { tabId: 'tab-leaf', worktreeId: TEST_WORKTREE_ID, leafId: 'pane:1', paneRuntimeId: 1, ptyId }
    ]
  })
}

async function followLink(runtime: InstanceType<typeof OrcaRuntimeService>, handle: string) {
  const state = new TerminalDeepLinkState()
  expect(state.capture(['orca', `orca://terminal/${handle}`], runtime)).toBe(true)
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('orca://terminal deep link against the runtime', () => {
  it('accepts every handle shape the runtime mints', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController(ptyController())
    runtime.setNotifier(recordingNotifier().notifier)
    runtime.attachWindow(1)
    syncSingleLeaf(runtime, 'pty-leaf')
    const created = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    const [listed] = (await runtime.listTerminals()).terminals
    const handles = [
      created.handle,
      listed!.handle,
      runtime.createPreAllocatedTerminalHandle(),
      deriveRemoteRuntimeTerminalCreateHandle('client', TEST_WORKTREE_ID, 'mutation-1'),
      `term_${deterministicAgentSessionUuid('operation:handle')}`
    ]

    for (const handle of handles) {
      expect(parseTerminalDeepLink(`orca://terminal/${handle}`)).toBe(handle)
    }
  })

  it('focuses a live renderer leaf through the notifier focus path only', async () => {
    const runtime = new OrcaRuntimeService(store)
    const recorder = recordingNotifier()
    runtime.setPtyController(ptyController(undefined, new Set(['pty-leaf'])))
    runtime.setNotifier(recorder.notifier)
    runtime.attachWindow(1)
    syncSingleLeaf(runtime, 'pty-leaf')
    const terminal = (await runtime.listTerminals()).terminals.find(
      (candidate) => candidate.tabId === 'tab-leaf'
    )
    recorder.calls.length = 0

    await followLink(runtime, terminal!.handle)

    expect(recorder.focusTerminal).toHaveBeenCalledWith('tab-leaf', TEST_WORKTREE_ID, 'pane:1')
    expect(recorder.calls).toEqual(['focusTerminal'])
  })

  it('focuses a live terminal on the first link after launch, once the PTY provider has started', async () => {
    let finishStartup: (() => void) | undefined
    const providerStartup = new Promise<void>((resolve) => {
      finishStartup = resolve
    })
    const runtime = new OrcaRuntimeService(store)
    const recorder = recordingNotifier()
    runtime.setPtyController(ptyController(undefined, new Set(['pty-leaf']), providerStartup))
    runtime.setNotifier(recorder.notifier)
    runtime.attachWindow(1)
    syncSingleLeaf(runtime, 'pty-leaf')
    const terminal = (await runtime.listTerminals()).terminals.find(
      (candidate) => candidate.tabId === 'tab-leaf'
    )
    recorder.calls.length = 0
    const state = new TerminalDeepLinkState()

    state.capture(['orca', `orca://terminal/${terminal!.handle}`], runtime)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(recorder.calls).toEqual([])
    finishStartup!()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(recorder.focusTerminal).toHaveBeenCalledWith('tab-leaf', TEST_WORKTREE_ID, 'pane:1')
  })

  it('never focuses a slept pane, whose worktree activation would wake its agent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runtime = new OrcaRuntimeService(store)
    const recorder = recordingNotifier()
    runtime.setNotifier(recorder.notifier)
    runtime.attachWindow(1)
    syncSingleLeaf(runtime, null)
    const [terminal] = (await runtime.listTerminals()).terminals
    recorder.calls.length = 0

    await followLink(runtime, terminal!.handle)

    expect(recorder.calls).toEqual([])
    expect(warn).toHaveBeenCalledWith(
      `[deep-link] Ignored orca://terminal/${terminal!.handle}: "terminal_exited"`
    )
    // The CLI focus path still selects the slept tab; only the deep link refuses it.
    await runtime.focusTerminal(terminal!.handle)
    expect(recorder.calls).toEqual(['focusTerminal'])
    warn.mockRestore()
  })

  it.each([
    ['provider has no such PTY', null, ptyController(), 'terminal_exited'],
    ['PTY exited', 0, ptyController(), 'terminal_exited'],
    ['no provider can answer', null, null, 'terminal_unverifiable']
  ])(
    'never focuses a slept pane that kept its dead ptyId (%s)',
    async (_label, exitCode, controller, reason) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const runtime = new OrcaRuntimeService(store)
      const recorder = recordingNotifier()
      if (controller) {
        runtime.setPtyController(controller)
      }
      runtime.setNotifier(recorder.notifier)
      runtime.attachWindow(1)
      syncSingleLeaf(runtime, 'pty-pre-sleep')
      if (exitCode !== null) {
        runtime.registerPty('pty-pre-sleep', TEST_WORKTREE_ID)
        runtime.onPtyExit('pty-pre-sleep', exitCode)
      }
      const terminal = (await runtime.listTerminals()).terminals.find(
        (candidate) => candidate.tabId === 'tab-leaf'
      )
      recorder.calls.length = 0

      await followLink(runtime, terminal!.handle)

      expect(recorder.calls).toEqual([])
      expect(warn).toHaveBeenCalledWith(
        `[deep-link] Ignored orca://terminal/${terminal!.handle}: "${reason}"`
      )
      // The CLI focus path still selects it; only the deep link refuses.
      await runtime.focusTerminal(terminal!.handle)
      expect(recorder.calls).toEqual(['focusTerminal'])
      warn.mockRestore()
    }
  )

  it('never focuses an SSH terminal whose transport is down, even if its record reads connected', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ptyId = toAppSshPtyId('ssh-target', 'pty-1')
    const runtime = new OrcaRuntimeService(store)
    const recorder = recordingNotifier()
    runtime.setPtyController(ptyController(undefined, new Set([ptyId])))
    runtime.setNotifier(recorder.notifier)
    runtime.attachWindow(1)
    syncSingleLeaf(runtime, ptyId)
    runtime.registerPty(ptyId, TEST_WORKTREE_ID, 'ssh-target')
    const terminal = (await runtime.listTerminals()).terminals.find(
      (candidate) => candidate.tabId === 'tab-leaf'
    )
    expect(terminal!.connected).toBe(true)
    recorder.calls.length = 0

    await followLink(runtime, terminal!.handle)

    expect(recorder.calls).toEqual([])
    expect(warn).toHaveBeenCalledWith(
      `[deep-link] Ignored orca://terminal/${terminal!.handle}: "terminal_unverifiable"`
    )
    warn.mockRestore()
  })

  it('never reveals an exited background terminal', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runtime = new OrcaRuntimeService(store)
    const recorder = recordingNotifier()
    runtime.setPtyController(ptyController())
    runtime.setNotifier(recorder.notifier)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      presentation: 'background'
    })
    runtime.onPtyExit('pty-bg', 0)
    recorder.calls.length = 0

    await followLink(runtime, handle)

    expect(recorder.calls).toEqual([])
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('attaches a view to a running background terminal without spawning a process', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const runtime = new OrcaRuntimeService(store)
    const recorder = recordingNotifier()
    runtime.setPtyController(ptyController(spawn))
    runtime.setNotifier(recorder.notifier)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      presentation: 'background'
    })
    recorder.calls.length = 0

    await followLink(runtime, handle)

    expect(spawn).toHaveBeenCalledOnce()
    expect(recorder.revealTerminalSession).toHaveBeenCalledWith(
      TEST_WORKTREE_ID,
      expect.objectContaining({ ptyId: 'pty-bg' })
    )
    expect(recorder.revealTerminalSession.mock.calls[0]![1]).not.toHaveProperty('command')
    expect(recorder.calls.every((name) => FOCUS_ONLY_NOTIFIER_METHODS.has(name))).toBe(true)
  })
})
