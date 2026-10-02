import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'

function createRedrawRuntime(initialSize = { cols: 80, rows: 24 }) {
  const runtime = new OrcaRuntimeService()
  const requestRedraw = vi.fn(async () => true)
  let size = initialSize
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    getSize: () => size,
    requestRedraw
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: These handlers read only ptyId from the resolved leaf.
  const leaf = { ptyId: 'pty-1' } as NonNullable<
    ReturnType<typeof runtime.resolveLiveLeafForHandle>
  >
  const resolve = vi.spyOn(runtime, 'resolveLiveLeafForHandle').mockReturnValue(leaf)
  const refresh = vi.spyOn(runtime, 'refreshRemoteDesktopViewer').mockResolvedValue(true)
  vi.spyOn(runtime, 'getLayout').mockReturnValue(null)
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
  const update = (extra: { redraw?: boolean; claim?: boolean } = { redraw: true }) =>
    dispatcher.dispatch({
      id: 'req-1',
      authToken: 'token',
      method: 'terminal.updateViewport',
      params: {
        terminal: 'terminal-1',
        client: { id: 'client-1', type: 'desktop' },
        viewport: initialSize,
        ...extra
      }
    })
  return {
    runtime,
    requestRedraw,
    resolve,
    refresh,
    update,
    setSize: (next: typeof size) => {
      size = next
    }
  }
}

describe('remote reattach redraw through the existing viewport RPC', () => {
  it('kicks an unchanged grid once without claiming control', async () => {
    const { update, requestRedraw, refresh } = createRedrawRuntime()
    expect((await update()).ok).toBe(true)
    expect(requestRedraw).toHaveBeenCalledExactlyOnceWith('pty-1')
    expect(refresh).toHaveBeenCalledWith('pty-1', 'client-1', 80, 24, false)
  })

  it.each([
    { cols: 20, rows: 8 },
    { cols: 240, rows: 120 }
  ])('kicks an unchanged host-clamped $cols×$rows grid', async (viewport) => {
    const { update, requestRedraw } = createRedrawRuntime(viewport)
    expect((await update()).ok).toBe(true)
    expect(requestRedraw).toHaveBeenCalledExactlyOnceWith('pty-1')
  })

  it('leaves ordinary viewport updates unchanged', async () => {
    const { update, requestRedraw } = createRedrawRuntime()
    expect((await update({})).ok).toBe(true)
    expect(requestRedraw).not.toHaveBeenCalled()
  })

  it('does not double-signal a real geometry change', async () => {
    const { update, requestRedraw, setSize, refresh } = createRedrawRuntime()
    setSize({ cols: 100, rows: 30 })
    refresh.mockImplementation(async () => {
      setSize({ cols: 80, rows: 24 })
      return true
    })
    expect((await update()).ok).toBe(true)
    expect(requestRedraw).not.toHaveBeenCalled()
  })

  it('does not kick a viewer whose stream has gone away', async () => {
    const { update, requestRedraw, refresh } = createRedrawRuntime()
    refresh.mockResolvedValue(false)
    expect((await update()).ok).toBe(true)
    expect(requestRedraw).not.toHaveBeenCalled()
  })

  it('rechecks mobile ownership after the viewport await', async () => {
    const { runtime, update, requestRedraw, refresh } = createRedrawRuntime()
    refresh.mockImplementation(async () => {
      runtime.markMobileActor('pty-1', 'phone-1')
      return true
    })
    expect((await update()).ok).toBe(true)
    expect(requestRedraw).not.toHaveBeenCalled()
  })

  it('rechecks the applied grid after the viewport await', async () => {
    const { update, requestRedraw, refresh, setSize } = createRedrawRuntime()
    refresh.mockImplementation(async () => {
      setSize({ cols: 100, rows: 30 })
      return true
    })
    expect((await update()).ok).toBe(true)
    expect(requestRedraw).not.toHaveBeenCalled()
  })

  it('refuses a replaced handle after the viewport await', async () => {
    const { update, requestRedraw, resolve, refresh } = createRedrawRuntime()
    refresh.mockImplementation(async () => {
      resolve.mockImplementation(() => {
        throw new Error('terminal_handle_stale')
      })
      return true
    })
    expect((await update()).ok).toBe(false)
    expect(requestRedraw).not.toHaveBeenCalled()
  })

  it('degrades safely when the controller cannot request redraw', async () => {
    const { runtime, update } = createRedrawRuntime()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      getSize: () => ({ cols: 80, rows: 24 })
    })
    expect((await update()).ok).toBe(true)
  })
})
