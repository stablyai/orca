import { describe, expect, it, vi } from 'vitest'
import type { HerdrHostTransport, HerdrTerminalController } from './herdr-runtime-contract'
import { isHerdrAttachBusy, openSharedHerdrPaneController } from './herdr-pty-attach'

function closedController(reason: string): HerdrTerminalController {
  return {
    write: vi.fn(),
    resize: vi.fn(),
    release: vi.fn(),
    onFrame: () => () => undefined,
    onClosed: (listener) => {
      listener({ type: 'terminal.closed', reason })
      return () => undefined
    }
  }
}

function frameController(): HerdrTerminalController {
  return {
    write: vi.fn(),
    resize: vi.fn(),
    release: vi.fn(),
    onFrame: (listener) => {
      listener({
        type: 'terminal.frame',
        seq: 1,
        encoding: 'ansi',
        width: 80,
        height: 24,
        full: true,
        bytes: ''
      })
      return () => undefined
    },
    onClosed: () => () => undefined
  }
}

describe('openSharedHerdrPaneController', () => {
  it('keeps exclusive control when the pane is free', async () => {
    const exclusive = frameController()
    const transport = {
      controlTerminal: vi.fn(() => exclusive)
    } as unknown as HerdrHostTransport
    const opened = await openSharedHerdrPaneController(transport, 'orca', 'w1:p1', {
      cols: 80,
      rows: 24
    })
    expect(opened.sharedAttach).toBe(false)
    expect(transport.controlTerminal).toHaveBeenCalledTimes(1)
    const onFrame = vi.fn()
    opened.controller.onFrame(onFrame)
    expect(onFrame).toHaveBeenCalled()
  })

  it('observes when another client already owns exclusive control', async () => {
    const busy = closedController('pane already has an attached client; retry with --takeover')
    const observer = frameController()
    const transport = {
      controlTerminal: vi.fn().mockReturnValueOnce(busy).mockReturnValueOnce(observer)
    } as unknown as HerdrHostTransport
    const opened = await openSharedHerdrPaneController(transport, 'orca', 'w1:p1', {
      cols: 80,
      rows: 24
    })
    expect(opened.sharedAttach).toBe(true)
    expect(busy.release).toHaveBeenCalled()
    expect(transport.controlTerminal).toHaveBeenLastCalledWith('orca', 'w1:p1', {
      cols: 80,
      rows: 24,
      observe: true
    })
  })

  it('detects Herdr attach-busy errors', () => {
    expect(isHerdrAttachBusy('already has an attached client; retry with --takeover')).toBe(true)
    expect(isHerdrAttachBusy('connection reset')).toBe(false)
  })
})
