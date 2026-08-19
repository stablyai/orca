import { describe, expect, it, vi } from 'vitest'
import type { HerdrHostTransport, HerdrTerminalController } from './herdr-runtime-contract'
import type { HerdrPtyBinding } from './herdr-pty-types'
import {
  applyHerdrPaneSize,
  openSharedHerdrPaneController,
  writeSharedHerdrInput
} from './herdr-pty-attach'

describe('openSharedHerdrPaneController', () => {
  it('observes so a Herdr TUI can keep exclusive control', () => {
    const observer = {
      write: vi.fn(),
      resize: vi.fn(),
      release: vi.fn(),
      onFrame: vi.fn(() => () => undefined),
      onClosed: vi.fn(() => () => undefined)
    } as unknown as HerdrTerminalController
    const transport = {
      controlTerminal: vi.fn(() => observer)
    } as unknown as HerdrHostTransport
    const controller = openSharedHerdrPaneController(transport, 'orca', 'w1:p1', {
      cols: 80,
      rows: 24
    })
    expect(controller).toBe(observer)
    expect(transport.controlTerminal).toHaveBeenCalledWith('orca', 'w1:p1', {
      cols: 80,
      rows: 24,
      observe: true
    })
  })
})

describe('applyHerdrPaneSize', () => {
  it('pulses exclusive control so observe can still share with a Herdr TUI', async () => {
    const exclusive = {
      write: vi.fn(),
      resize: vi.fn(),
      release: vi.fn(),
      onFrame: (listener: (frame: { type: 'terminal.frame' }) => void) => {
        queueMicrotask(() => listener({ type: 'terminal.frame' }))
        return () => undefined
      },
      onClosed: vi.fn(() => () => undefined)
    } as unknown as HerdrTerminalController
    const transport = {
      controlTerminal: vi.fn(() => exclusive)
    } as unknown as HerdrHostTransport
    const binding = {
      detached: false,
      cols: 160,
      rows: 48,
      sessionName: 'orca',
      paneId: 'w1:p1',
      transport
    } as unknown as HerdrPtyBinding
    applyHerdrPaneSize(binding)
    applyHerdrPaneSize(binding)
    expect(transport.controlTerminal).toHaveBeenCalledTimes(1)
    expect(transport.controlTerminal).toHaveBeenCalledWith('orca', 'w1:p1', {
      cols: 160,
      rows: 48
    })
    await Promise.resolve()
    expect(exclusive.resize).toHaveBeenCalledWith(160, 48)
    expect(exclusive.release).toHaveBeenCalled()
  })

  it('gives up when a Herdr TUI already owns exclusive control', () => {
    const exclusive = {
      write: vi.fn(),
      resize: vi.fn(),
      release: vi.fn(),
      onFrame: vi.fn(() => () => undefined),
      onClosed: (listener: (event: { type: 'terminal.closed'; reason: string }) => void) => {
        listener({
          type: 'terminal.closed',
          reason: 'pane already has an attached client; retry with --takeover'
        })
        return () => undefined
      }
    } as unknown as HerdrTerminalController
    const transport = {
      controlTerminal: vi.fn(() => exclusive)
    } as unknown as HerdrHostTransport
    applyHerdrPaneSize({
      detached: false,
      cols: 160,
      rows: 48,
      sessionName: 'orca',
      paneId: 'w1:p1',
      transport
    } as unknown as HerdrPtyBinding)
    expect(exclusive.resize).not.toHaveBeenCalled()
    expect(exclusive.release).toHaveBeenCalled()
  })
})

describe('writeSharedHerdrInput', () => {
  it('types through pane.send_text so observe does not steal exclusive control', async () => {
    const request = vi.fn(async () => ({ id: '1', result: { type: 'ok' } }))
    const binding = {
      sessionName: 'orca',
      paneId: 'w1:p1',
      transport: { request }
    } as unknown as HerdrPtyBinding
    await writeSharedHerdrInput(binding, 'hello')
    expect(request).toHaveBeenCalledWith('orca', 'pane.send_text', {
      pane_id: 'w1:p1',
      text: 'hello'
    })
  })
})
