import { createElement, type RefObject } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  useInitialSessionTerminalAutoCreate,
  useWorktreeSessionTabsLoaded
} from './use-initial-session-terminal-autocreate'

type HarnessProps = {
  newlyCreatedWorkspace: boolean
  terminalsLoaded: boolean
  visibleTabCount: number
  worktreeId: string
  connected?: boolean
  hasClient?: boolean
}

describe('useInitialSessionTerminalAutoCreate', () => {
  let renderer: ReactTestRenderer | null = null
  let stateRef: RefObject<{
    autoCreatedForWorktree: string | null
    sawSessionTabs: boolean
  }>
  const consumeCreationRoute = vi.fn()
  const createTerminal = vi.fn()

  function Harness(props: HarnessProps): null {
    useInitialSessionTerminalAutoCreate({
      client: props.hasClient === false ? null : {},
      newlyCreatedWorkspace: props.newlyCreatedWorkspace,
      connState: props.connected === false ? 'disconnected' : 'connected',
      terminalsLoaded: props.terminalsLoaded,
      visibleTabCount: props.visibleTabCount,
      activeHandle: null,
      createInFlight: false,
      stateRef,
      worktreeId: props.worktreeId,
      consumeCreationRoute,
      createTerminal
    })
    return null
  }

  async function render(props: HarnessProps): Promise<void> {
    await act(async () => {
      if (renderer) {
        renderer.update(createElement(Harness, props))
      } else {
        renderer = create(createElement(Harness, props))
      }
    })
  }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    stateRef = {
      current: { autoCreatedForWorktree: null, sawSessionTabs: false }
    }
    consumeCreationRoute.mockClear()
    createTerminal.mockClear()
    vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (typeof args[0] !== 'string' || !args[0].includes('react-test-renderer is deprecated')) {
        throw new Error(String(args[0]))
      }
    })
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.restoreAllMocks()
  })

  it('waits for the new worktree snapshot after route reuse', async () => {
    await render({
      newlyCreatedWorkspace: false,
      terminalsLoaded: true,
      visibleTabCount: 0,
      worktreeId: 'existing'
    })
    await render({
      newlyCreatedWorkspace: true,
      terminalsLoaded: false,
      visibleTabCount: 0,
      worktreeId: 'new'
    })
    expect(consumeCreationRoute).not.toHaveBeenCalled()
    expect(createTerminal).not.toHaveBeenCalled()

    await render({
      newlyCreatedWorkspace: true,
      terminalsLoaded: true,
      visibleTabCount: 0,
      worktreeId: 'new'
    })
    expect(consumeCreationRoute).not.toHaveBeenCalled()
    expect(createTerminal).toHaveBeenCalledOnce()

    await render({
      newlyCreatedWorkspace: true,
      terminalsLoaded: true,
      visibleTabCount: 1,
      worktreeId: 'new'
    })
    expect(consumeCreationRoute).toHaveBeenCalledOnce()
    expect(createTerminal).toHaveBeenCalledOnce()
  })

  it('consumes a populated creation route before a later remount', async () => {
    await render({
      newlyCreatedWorkspace: true,
      terminalsLoaded: true,
      visibleTabCount: 1,
      worktreeId: 'new'
    })
    expect(consumeCreationRoute).toHaveBeenCalledOnce()
    expect(createTerminal).not.toHaveBeenCalled()

    act(() => renderer?.unmount())
    renderer = null
    stateRef = {
      current: { autoCreatedForWorktree: null, sawSessionTabs: false }
    }
    await render({
      newlyCreatedWorkspace: false,
      terminalsLoaded: true,
      visibleTabCount: 0,
      worktreeId: 'new'
    })
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it.each([
    { connected: false, hasClient: true },
    { connected: true, hasClient: false }
  ])(
    'keeps the creation route armed until a client reconnects (connected=$connected, hasClient=$hasClient)',
    async ({ connected, hasClient }) => {
      await render({
        newlyCreatedWorkspace: true,
        terminalsLoaded: true,
        visibleTabCount: 0,
        worktreeId: 'new',
        connected,
        hasClient
      })
      expect(consumeCreationRoute).not.toHaveBeenCalled()
      expect(createTerminal).not.toHaveBeenCalled()

      await render({
        newlyCreatedWorkspace: true,
        terminalsLoaded: true,
        visibleTabCount: 0,
        worktreeId: 'new'
      })
      expect(consumeCreationRoute).not.toHaveBeenCalled()
      expect(createTerminal).toHaveBeenCalledOnce()
    }
  )
})

describe('useWorktreeSessionTabsLoaded', () => {
  let renderer: ReactTestRenderer | null = null
  let current: readonly [boolean, (loaded: boolean) => void] | null = null

  function Harness({ worktreeId }: { worktreeId: string }): null {
    current = useWorktreeSessionTabsLoaded(worktreeId)
    return null
  }

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    current = null
  })

  it('does not carry a loaded snapshot across a reused route', async () => {
    await act(async () => {
      renderer = create(createElement(Harness, { worktreeId: 'existing' }))
    })
    act(() => current?.[1](true))
    expect(current?.[0]).toBe(true)

    await act(async () => {
      renderer?.update(createElement(Harness, { worktreeId: 'new' }))
    })
    expect(current?.[0]).toBe(false)
  })
})
