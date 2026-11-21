import { describe, expect, it, vi } from 'vitest'
import { callPluginHost, pluginHostTestServices } from './__mocks__/plugin-host-services-fixture'

function desktopWindow() {
  return {
    openFile: vi.fn(),
    runAction: vi.fn(),
    openFolderWorkspace: vi.fn().mockResolvedValue(undefined),
    raiseWindow: vi.fn()
  }
}

describe('raiseWindow', () => {
  it.each([
    [true, 1],
    // A newer focus request won: the window shows something else, so it stays where it is.
    [false, 0]
  ])('terminal.focus raises the window only when it navigated (%s)', async (navigated, raises) => {
    const renderer = desktopWindow()
    const services = pluginHostTestServices(vi.fn().mockResolvedValue({ focus: { navigated } }), {
      renderer
    })

    const outcome = await callPluginHost({
      method: 'terminal.focus',
      params: { terminalId: 'term_1', raiseWindow: true },
      granted: ['workspace:write'],
      services
    })

    expect(outcome).toEqual({ ok: true, value: { focused: navigated } })
    expect(renderer.raiseWindow).toHaveBeenCalledTimes(raises)
  })

  it('workspace.open raises the window after the workspace opened', async () => {
    const renderer = desktopWindow()
    const runtimeRpc = vi.fn().mockImplementation(async () => {
      expect(renderer.raiseWindow).not.toHaveBeenCalled()
      return {}
    })

    const outcome = await callPluginHost({
      method: 'workspace.open',
      params: { workspaceId: 'identity:wt2:local:abc', raiseWindow: true },
      granted: ['workspace:write'],
      services: pluginHostTestServices(runtimeRpc, { renderer })
    })

    expect(outcome).toEqual({ ok: true, value: { opened: true } })
    expect(runtimeRpc).toHaveBeenCalledTimes(1)
    expect(renderer.raiseWindow).toHaveBeenCalledTimes(1)
  })

  it('workspace.open refuses raiseWindow on a host without a window, before opening anything', async () => {
    const runtimeRpc = vi.fn().mockResolvedValue({})

    const outcome = await callPluginHost({
      method: 'workspace.open',
      params: { workspaceId: 'identity:wt2:local:abc', raiseWindow: true },
      granted: ['workspace:write'],
      services: pluginHostTestServices(runtimeRpc)
    })

    expect(outcome).toEqual({
      ok: false,
      code: 'unavailable',
      error: 'only the Orca desktop app can do this'
    })
    expect(runtimeRpc).not.toHaveBeenCalled()
  })

  it('does not raise the window for a call its worker cancelled while it ran', async () => {
    const renderer = desktopWindow()
    const cancelled = new AbortController()
    const runtimeRpc = vi.fn().mockImplementation(async () => {
      cancelled.abort()
      return { focus: { navigated: true } }
    })

    await callPluginHost({
      method: 'terminal.focus',
      params: { terminalId: 'term_1', raiseWindow: true },
      granted: ['workspace:write'],
      services: pluginHostTestServices(runtimeRpc, { renderer }),
      scope: { assertActive: () => {}, signal: cancelled.signal }
    })

    expect(runtimeRpc).toHaveBeenCalledTimes(1)
    expect(renderer.raiseWindow).not.toHaveBeenCalled()
  })

  it('leaves the window where it is when a call does not ask for it', async () => {
    const renderer = desktopWindow()
    const services = pluginHostTestServices(
      vi.fn().mockResolvedValue({ focus: { navigated: true } }),
      { renderer }
    )

    const focus = await callPluginHost({
      method: 'terminal.focus',
      params: { terminalId: 'term_1' },
      granted: ['workspace:write'],
      services
    })
    const open = await callPluginHost({
      method: 'workspace.open',
      params: { workspaceId: 'identity:wt2:local:abc' },
      granted: ['workspace:write'],
      services
    })

    expect(focus).toEqual({ ok: true, value: { focused: true } })
    expect(open).toEqual({ ok: true, value: { opened: true } })
    expect(renderer.raiseWindow).not.toHaveBeenCalled()
  })
})
