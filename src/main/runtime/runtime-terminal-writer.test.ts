import { describe, expect, it } from 'vitest'
import { TERMINAL_INTERRUPT_KITTY_CTRL_C } from '../../shared/terminal-interrupt-bytes'
import { RuntimeTerminalWriter } from './runtime-terminal-writer'

describe('RuntimeTerminalWriter interrupt bytes', () => {
  it('writes a bare ETX when the PTY has no kitty keyboard flags', async () => {
    const writes: string[] = []
    const writer = new RuntimeTerminalWriter((ptyId, data) => {
      expect(ptyId).toBe('pty-1')
      writes.push(data)
      return true
    })

    await writer.writeAction('pty-1', { interrupt: true }, '\x03', { inputKind: 'driving' })

    expect(writes).toEqual(['\x03'])
  })

  it('writes the interrupt bytes already chosen for the payload', async () => {
    const writes: string[] = []
    const writer = new RuntimeTerminalWriter((_ptyId, data) => {
      writes.push(data)
      return true
    })

    await writer.writeAction('pty-1', { interrupt: true }, TERMINAL_INTERRUPT_KITTY_CTRL_C, {
      inputKind: 'driving'
    })

    expect(writes).toEqual([TERMINAL_INTERRUPT_KITTY_CTRL_C])
  })
})
