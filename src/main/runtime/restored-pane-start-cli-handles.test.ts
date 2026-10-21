// Layout-owner build: a CLI send, wait or read on a saved pane main holds with no terminal yet
// starts it through main's one starter, then delivers to the started terminal.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

// Fragments stay side-effect ordered: mocks, then lifecycle, then fixtures.
await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const {
  HEADLESS_THIRD_LEAF_ID: THIRD_LEAF_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  deferred
} = await import('./orca-runtime-test-fixtures.spec')
const { SURFACE_PTYS, SURFACE_TAB_ID, surfaceRuntime } =
  await import('./terminal/surface/terminal-surface-replies.test-fixture')
await import('./rpc/unused-default-rpc-methods.test-fixture')
const { RpcDispatcher } = await import('./rpc/dispatcher')
const { MOBILE_TERMINAL_SURFACE_TIMEOUT_MS } = await import('./orca-runtime-core')
const { TERMINAL_METHODS } = await import('./rpc/methods/terminal')

type Runtime = ReturnType<typeof surfaceRuntime>['runtime']

/**
 * A windowless host whose saved tab gained a third pane no terminal is bound to yet. Its start
 * records the binding as the host's controller does, unless `bindsOnStart` is false (a late bind).
 */
async function restoredPane({ bindsOnStart = true } = {}) {
  const { runtime, store, setSession } = surfaceRuntime()
  runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
  const session = store.getSession()
  const layout = session.terminalLayoutsByTabId[SURFACE_TAB_ID]!
  setSession({
    ...session,
    terminalLayoutsByTabId: {
      [SURFACE_TAB_ID]: {
        ...layout,
        root: {
          type: 'split',
          direction: 'vertical',
          first: layout.root!,
          second: { type: 'leaf', leafId: THIRD_LEAF_ID }
        }
      }
    }
  })
  const started = deferred<{ id: string }>()
  const bindThirdPane = (ptyId: string): void => {
    const current = store.getSession()
    const tab = current.terminalLayoutsByTabId[SURFACE_TAB_ID]!
    setSession({
      ...current,
      terminalLayoutsByTabId: {
        [SURFACE_TAB_ID]: {
          ...tab,
          ptyIdsByLeafId: { ...tab.ptyIdsByLeafId, [THIRD_LEAF_ID]: ptyId }
        }
      }
    })
  }
  const spawn = vi.fn(async () => {
    const result = await started.promise
    if (bindsOnStart) {
      bindThirdPane(result.id)
    }
    return result
  })
  const write = vi.fn(() => true)
  runtime.setPtyController({
    spawn,
    write,
    kill: () => true,
    stopAndWait: async () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () =>
      Object.values(SURFACE_PTYS).map((id) => ({ id, cwd: TEST_WORKTREE_PATH, title: 'sh' }))
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const listed = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
  const handle = listed.terminals.find((terminal) => terminal.leafId === THIRD_LEAF_ID)!.handle
  return { runtime, handle, spawn, started, write, bindThirdPane }
}

const DRIVING = { inputKind: 'driving' } as const

describe('a CLI trigger on a saved pane with no terminal (layout-owner build)', () => {
  it('a send starts the pane once and delivers to it, and the handle keeps naming it', async () => {
    const { runtime, handle, spawn, started, write } = await restoredPane()

    const send = runtime.sendTerminal(handle, { text: 'echo hi', enter: true }, DRIVING)
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    started.resolve({ id: 'pty-c' })

    await expect(send).resolves.toMatchObject({ handle, accepted: true })
    expect(write).toHaveBeenCalledWith('pty-c', 'echo hi', 'driving')
    await expect(
      runtime.sendTerminal(handle, { text: 'echo again', enter: true }, DRIVING)
    ).resolves.toMatchObject({ handle, accepted: true })
    expect(write).toHaveBeenCalledWith('pty-c', 'echo again', 'driving')
    expect(spawn).toHaveBeenCalledOnce()
  })

  it('a terminal.send request starts the pane once and delivers to it', async () => {
    const { runtime, handle, spawn, started, write } = await restoredPane()
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = dispatcher.dispatch({
      id: 'req-send',
      authToken: 'token',
      method: 'terminal.send',
      params: { terminal: handle, text: 'echo hi', enter: true }
    })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    started.resolve({ id: 'pty-c' })

    await expect(response).resolves.toMatchObject({
      ok: true,
      result: { send: { handle, accepted: true } }
    })
    expect(write).toHaveBeenCalledWith('pty-c', 'echo hi', 'driving')
    expect(spawn).toHaveBeenCalledOnce()
  })

  it('a wait starts the pane once and waits on the started terminal', async () => {
    const { runtime, handle, spawn, started } = await restoredPane()

    const wait = runtime.waitForTerminal(handle, { condition: 'exit', timeoutMs: 5_000 })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    started.resolve({ id: 'pty-c' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    runtime.onPtyExit('pty-c', 0)

    await expect(wait).resolves.toMatchObject({ handle, condition: 'exit', satisfied: true })
    expect(spawn).toHaveBeenCalledOnce()
  })

  it('a read starts the pane once and reads the started terminal', async () => {
    const { runtime, handle, spawn, started } = await restoredPane()

    const read = runtime.readTerminal(handle)
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    started.resolve({ id: 'pty-c' })

    await expect(read).resolves.toMatchObject({ handle, status: 'running' })
    runtime.onPtyData('pty-c', 'ready\r\n', Date.now())
    const again = await runtime.readTerminal(handle)
    expect(again.tail.join('\n')).toContain('ready')
    expect(spawn).toHaveBeenCalledOnce()
  })

  it('a CLI send and a phone opening the pane together start it once', async () => {
    const { runtime, handle, spawn, started, write } = await restoredPane()

    const phone = runtime.activateMobileSessionTab(
      `id:${TEST_WORKTREE_ID}`,
      SURFACE_TAB_ID,
      THIRD_LEAF_ID,
      { notifyClients: false, navigation: 'caller', intent: 'user' }
    )
    const send = runtime.sendTerminal(handle, { text: 'echo hi', enter: true }, DRIVING)
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    started.resolve({ id: 'pty-c' })

    await expect(send).resolves.toMatchObject({ accepted: true })
    await phone
    // The phone's row shows the one started terminal.
    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(
      listed.tabs.find((tab) => tab.id === `${SURFACE_TAB_ID}::${THIRD_LEAF_ID}`)
    ).toMatchObject({ status: 'ready', terminal: expect.any(String) })
    expect(spawn).toHaveBeenCalledOnce()
    expect(write).toHaveBeenCalledWith('pty-c', 'echo hi', 'driving')
  })

  it('a pane that cannot start fails the send with an error, not a hang', async () => {
    const { runtime, handle, started, write } = await restoredPane()

    const send = runtime.sendTerminal(handle, { text: 'echo hi', enter: true }, DRIVING)
    started.reject(new Error('spawn failed'))

    await expect(send).rejects.toThrow('spawn failed')
    expect(write).not.toHaveBeenCalled()
  })

  it('a wait that started the pane survives main binding it, and answers under the caller handle', async () => {
    const { runtime, handle, spawn, started, write, bindThirdPane } = await restoredPane({
      bindsOnStart: false
    })

    const wait = runtime.waitForTerminal(handle, { condition: 'exit', timeoutMs: 5_000 })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    started.resolve({ id: 'pty-c' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    bindThirdPane('pty-c')
    await new Promise((resolve) => setTimeout(resolve, 10))
    // The caller's own handle now names the bound pane (adopted), not only the started terminal's.
    expect(runtime.resolveLiveLeafForHandle(handle)?.ptyId).toBe('pty-c')
    await expect(
      runtime.sendTerminal(handle, { text: 'echo bound', enter: true }, DRIVING)
    ).resolves.toMatchObject({ handle, accepted: true })
    expect(write).toHaveBeenCalledWith('pty-c', 'echo bound', 'driving')
    runtime.onPtyExit('pty-c', 0)

    await expect(wait).resolves.toMatchObject({ handle, condition: 'exit', satisfied: true })
    expect(spawn).toHaveBeenCalledOnce()
  })

  it("a wait's timeout covers a start that never finishes", async () => {
    const { runtime, handle } = await restoredPane()

    await expect(
      runtime.waitForTerminal(handle, { condition: 'exit', timeoutMs: 50 })
    ).rejects.toThrow('timeout')
  })

  describe('a start that never finishes errors within the create bound, never a hang', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it.each([
      ['a read', (runtime: Runtime, handle: string) => runtime.readTerminal(handle)],
      [
        'a tui-idle wait with no timeout',
        (runtime: Runtime, handle: string) =>
          runtime.waitForTerminal(handle, { condition: 'tui-idle' })
      ]
    ])('%s', async (_name, call) => {
      const { runtime, handle, spawn } = await restoredPane()
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

      const outcome = call(runtime, handle).then(
        () => 'settled',
        (error: unknown) => (error instanceof Error ? error.message : String(error))
      )
      await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
      await vi.advanceTimersByTimeAsync(MOBILE_TERMINAL_SURFACE_TIMEOUT_MS)

      await expect(outcome).resolves.toBe('runtime_timeout')
    })
  })
})
