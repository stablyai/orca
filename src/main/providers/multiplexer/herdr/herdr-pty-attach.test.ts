import { describe, expect, it, vi } from 'vitest'
import type { HerdrHostTransport, HerdrTerminalController } from './herdr-runtime-contract'
import type { HerdrPtyBinding } from './herdr-pty-types'
import { openSharedHerdrPaneController, writeSharedHerdrInput } from './herdr-pty-attach'

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
