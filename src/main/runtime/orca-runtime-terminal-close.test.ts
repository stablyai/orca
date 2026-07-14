import { describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'
import { OrcaRuntimeService } from './orca-runtime'

const WORKTREE_ID = 'repo-1::/tmp/worktree'
const TAB_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_TAB_ID = '22222222-2222-4222-8222-222222222222'
const LEAF_ID = '33333333-3333-4333-8333-333333333333'

function registerPtyBackedHandle(
  runtime: OrcaRuntimeService,
  options: { tabId?: string } = { tabId: TAB_ID }
): string {
  const handle = runtime.createPreAllocatedTerminalHandle()
  runtime.registerPreAllocatedHandleForPty('pty-1', handle)
  runtime.registerPty(
    'pty-1',
    WORKTREE_ID,
    null,
    options.tabId ? { tabId: options.tabId, leafId: LEAF_ID } : undefined
  )
  return handle
}

function registerGraphBackedHandle(runtime: OrcaRuntimeService): string {
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        title: 'Terminal',
        activeLeafId: LEAF_ID,
        layout: null
      }
    ],
    leaves: [
      {
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        leafId: LEAF_ID,
        paneRuntimeId: 7,
        ptyId: 'pty-graph',
        paneTitle: 'Terminal'
      }
    ]
  })
  return runtime.resolveTerminalPane(makePaneKey(TAB_ID, LEAF_ID)).handle
}

function attachCloseNotifier(runtime: OrcaRuntimeService, closeTerminal: ReturnType<typeof vi.fn>) {
  runtime.setNotifier({ closeTerminal } as never)
}

describe('terminal close modes', () => {
  it('keeps the default PTY-first close behavior', async () => {
    const kill = vi.fn(() => true)
    const closeTerminal = vi.fn()
    const runtime = new OrcaRuntimeService()
    runtime.setPtyController({ kill } as never)
    attachCloseNotifier(runtime, closeTerminal)
    const handle = registerPtyBackedHandle(runtime)

    await expect(runtime.closeTerminal(handle)).resolves.toEqual({
      handle,
      tabId: TAB_ID,
      closeMode: 'terminal',
      tabCloseRequested: false,
      ptyKilled: true
    })
    expect(kill).toHaveBeenCalledOnce()
    expect(closeTerminal).not.toHaveBeenCalled()
  })

  it('requests one renderer tab close for a live PTY without killing it first', async () => {
    const kill = vi.fn(() => true)
    const closeTerminal = vi.fn()
    const runtime = new OrcaRuntimeService()
    runtime.setPtyController({ kill } as never)
    attachCloseNotifier(runtime, closeTerminal)
    const handle = registerPtyBackedHandle(runtime)

    await expect(runtime.closeTerminal(handle, 'tab')).resolves.toEqual({
      handle,
      tabId: TAB_ID,
      closeMode: 'tab',
      tabCloseRequested: true,
      ptyKilled: false
    })
    expect(closeTerminal).toHaveBeenCalledOnce()
    expect(closeTerminal).toHaveBeenCalledWith(TAB_ID)
    expect(kill).not.toHaveBeenCalled()
  })

  it('requests one renderer tab close for a graph-backed handle', async () => {
    const kill = vi.fn(() => true)
    const closeTerminal = vi.fn()
    const runtime = new OrcaRuntimeService()
    runtime.setPtyController({ kill } as never)
    attachCloseNotifier(runtime, closeTerminal)
    const handle = registerGraphBackedHandle(runtime)

    await expect(runtime.closeTerminal(handle, 'tab')).resolves.toMatchObject({
      handle,
      tabId: TAB_ID,
      closeMode: 'tab',
      tabCloseRequested: true,
      ptyKilled: false
    })
    expect(closeTerminal).toHaveBeenCalledOnce()
    expect(closeTerminal).toHaveBeenCalledWith(TAB_ID)
    expect(kill).not.toHaveBeenCalled()
  })

  it('fails closed when tab close has no attached renderer notifier', async () => {
    const kill = vi.fn(() => true)
    const runtime = new OrcaRuntimeService()
    runtime.setPtyController({ kill } as never)
    const handle = registerPtyBackedHandle(runtime)

    await expect(runtime.closeTerminal(handle, 'tab')).rejects.toThrow(
      'terminal_tab_close_unavailable'
    )
    expect(kill).not.toHaveBeenCalled()
  })

  it('rejects an unsealed or malformed handle before requesting a tab close', async () => {
    const closeTerminal = vi.fn()
    const runtime = new OrcaRuntimeService()
    attachCloseNotifier(runtime, closeTerminal)

    await expect(runtime.closeTerminal('not-a-terminal-handle', 'tab')).rejects.toThrow(
      'terminal_handle_stale'
    )
    expect(closeTerminal).not.toHaveBeenCalled()
  })

  it('rejects a live PTY whose sealed handle has no renderer tab identity', async () => {
    const closeTerminal = vi.fn()
    const runtime = new OrcaRuntimeService()
    attachCloseNotifier(runtime, closeTerminal)
    const handle = registerPtyBackedHandle(runtime, { tabId: undefined })

    await expect(runtime.closeTerminal(handle, 'tab')).rejects.toThrow(
      'terminal_tab_identity_missing'
    )
    expect(closeTerminal).not.toHaveBeenCalled()
  })

  it('rejects conflicting tab identities instead of choosing one', async () => {
    const closeTerminal = vi.fn()
    const runtime = new OrcaRuntimeService()
    attachCloseNotifier(runtime, closeTerminal)
    const handle = registerPtyBackedHandle(runtime)
    const internals = runtime as unknown as {
      ptysById: Map<string, { paneKey: string | null }>
    }
    internals.ptysById.get('pty-1')!.paneKey = makePaneKey(OTHER_TAB_ID, LEAF_ID)

    await expect(runtime.closeTerminal(handle, 'tab')).rejects.toThrow(
      'terminal_tab_identity_ambiguous'
    )
    expect(closeTerminal).not.toHaveBeenCalled()
  })
})
