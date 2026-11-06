import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

function createRuntime(hasLocalPane = false) {
  const runtime = new OrcaRuntimeService()
  const reportFocusLost = vi.fn(async () => {})
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: viewer presence and client disconnect reach only these controller members.
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    attach: vi.fn(async () => {}),
    hasRendererSerializer: () => hasLocalPane,
    reportFocusLost
  } as never)
  const view = (deviceId: string) =>
    runtime.registerRemoteTerminalViewSubscriber('pty-1', undefined, undefined, false, deviceId)
  return { runtime, reportFocusLost, view }
}

describe('remote terminal viewer focus loss', () => {
  it('reports focus lost when the last device viewing a PTY disconnects', () => {
    const { runtime, reportFocusLost, view } = createRuntime()
    const laptop = view('laptop')
    const otherLaptop = view('other-laptop')

    laptop()
    runtime.onClientDisconnected('laptop')
    expect(reportFocusLost).not.toHaveBeenCalled()

    otherLaptop()
    runtime.onClientDisconnected('other-laptop')
    expect(reportFocusLost).toHaveBeenCalledTimes(1)
    expect(reportFocusLost).toHaveBeenCalledWith('pty-1')
  })

  it('treats a resubscribe from a still-connected device as no departure', () => {
    const { runtime, reportFocusLost, view } = createRuntime()
    view('laptop')()
    view('laptop')
    runtime.onClientDisconnected('phone')

    expect(reportFocusLost).not.toHaveBeenCalled()
  })

  it('leaves focus to a mounted local pane', () => {
    const { runtime, reportFocusLost, view } = createRuntime(true)
    view('phone')()
    runtime.onClientDisconnected('phone')

    expect(reportFocusLost).not.toHaveBeenCalled()
  })
})
