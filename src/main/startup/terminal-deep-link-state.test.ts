import { describe, expect, it, vi } from 'vitest'
import type { TerminalPaneRevealTarget } from '../../shared/terminal-pane-reveal'
import { TerminalDeepLinkState, type TerminalDeepLinkHost } from './terminal-deep-link-state'

const HANDLE = 'term_1ef09c76-6f1b-4c3e-9d7a-0b6c2f9e4a11'

function createHost(options: { graphReady: boolean }) {
  let graphReady = options.graphReady
  const host = {
    isWindowGraphReady: () => graphReady,
    runtime: {
      focusTerminal: vi.fn(async (handle: string) => ({
        handle,
        tabId: 'tab-local',
        worktreeId: 'wt-local',
        navigated: true
      })),
      revealTerminalPane: vi.fn(async (target: TerminalPaneRevealTarget) => ({
        ...target,
        navigated: true
      }))
    },
    resolveEnvironmentId: vi.fn((selector: string) =>
      selector === 'macbook-pro-16' ? 'env-7f3a' : selector
    ),
    showEnvironmentTerminal: vi.fn(async () => ({
      worktreeId: 'repo-1::/Users/me/src/app',
      tabId: 'tab-remote',
      leafId: 'leaf-remote'
    }))
  } satisfies TerminalDeepLinkHost
  return { host, markGraphReady: () => (graphReady = true) }
}

describe('TerminalDeepLinkState', () => {
  it('holds a cold-start link until the window graph is ready, then switches once', async () => {
    const state = new TerminalDeepLinkState()
    const { host, markGraphReady } = createHost({ graphReady: false })

    expect(state.capture(['Orca', `orca://terminal/${HANDLE}`], () => host)).toBe(true)
    expect(host.runtime.focusTerminal).not.toHaveBeenCalled()

    markGraphReady()
    await state.deliver(() => host)
    await state.deliver(() => host)

    expect(host.runtime.focusTerminal).toHaveBeenCalledExactlyOnceWith(HANDLE, {
      navigateHost: true
    })
  })

  it("shows a paired server's terminal in this window instead of navigating that server", async () => {
    const state = new TerminalDeepLinkState()
    const { host } = createHost({ graphReady: true })

    state.capture([`orca://terminal/${HANDLE}?environment=macbook-pro-16`], () => host)
    await vi.waitFor(() => expect(host.runtime.revealTerminalPane).toHaveBeenCalled())

    expect(host.showEnvironmentTerminal).toHaveBeenCalledWith('env-7f3a', HANDLE)
    expect(host.runtime.revealTerminalPane).toHaveBeenCalledWith({
      worktreeId: 'repo-1::/Users/me/src/app',
      tabId: 'tab-remote',
      leafId: 'leaf-remote',
      executionHostId: 'runtime:env-7f3a'
    })
    expect(host.runtime.focusTerminal).not.toHaveBeenCalled()
  })

  it('drops a link it cannot resolve without throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const state = new TerminalDeepLinkState()
    const { host } = createHost({ graphReady: true })
    host.runtime.focusTerminal.mockRejectedValueOnce(new Error('terminal_handle_stale'))

    state.capture([`orca://terminal/${HANDLE}`], () => host)

    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce())
    expect(String(warn.mock.calls[0]?.[0])).toContain('terminal_handle_stale')
    warn.mockRestore()
  })
})
