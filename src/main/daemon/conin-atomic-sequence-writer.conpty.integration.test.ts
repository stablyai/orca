/**
 * Real-ConPTY oracle for the conin atomic-sequence guard.
 *
 * Ground truth (measured on Windows 11 26200): conhost's VT input parser does
 * NOT keep state across conin write boundaries. An escape sequence split
 * across two writes loses its head (silently swallowed) and delivers its tail
 * to the foreground app as literal keystrokes — the initiator of the
 * "backspace types a space after session resume" composer corruption.
 *
 * The first test documents that raw ConPTY behavior (the guard's reason to
 * exist); the second proves the guard restores whole-sequence delivery.
 */
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { ConinAtomicSequenceWriter } from './conin-atomic-sequence-writer'

const isWindows = process.platform === 'win32'

type PtyChild = {
  received: () => string
  write: (data: string) => void
  kill: () => void
}

async function spawnRawStdinDumper(): Promise<PtyChild> {
  const require = createRequire(import.meta.url)
  const pty = require('node-pty')
  // Child echoes every raw stdin chunk as RECV[<json>] so the test can read
  // exactly what conhost delivered to the application.
  const childScript =
    "process.stdin.setRawMode(true);process.stdin.on('data',(d)=>{process.stdout.write('RECV['+JSON.stringify(d.toString('latin1'))+']');});setTimeout(()=>process.exit(0),20000);"
  const proc = pty.spawn(process.execPath, ['-e', childScript], {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd: process.cwd(),
    env: process.env
  })
  let raw = ''
  proc.onData((d: string) => {
    raw += d
  })
  // Wait for the child's raw mode to engage (first prompt-less idle moment).
  await new Promise((r) => setTimeout(r, 2000))
  return {
    received: () => {
      const parts = [...raw.matchAll(/RECV\[("(?:[^"\\]|\\.)*")\]/g)]
      return parts.map((m) => JSON.parse(m[1]) as string).join('')
    },
    write: (data: string) => proc.write(data),
    kill: () => proc.kill()
  }
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe.runIf(isWindows)('ConPTY conin write-boundary behavior', () => {
  it('documents the defect: a split CSI loses its head and types its tail', async () => {
    const child = await spawnRawStdinDumper()
    try {
      child.write('\x1b[?997;1')
      child.write('n')
      await settle(1200)
      // Head swallowed, tail delivered literally — the corruption this guard
      // exists to prevent. If a future ConPTY fixes this, the assertion below
      // starts failing and the guard can be re-evaluated.
      expect(child.received()).toBe('n')
    } finally {
      child.kill()
    }
  }, 30000)

  it('guard restores whole-sequence delivery through a real ConPTY', async () => {
    const child = await spawnRawStdinDumper()
    try {
      const writer = new ConinAtomicSequenceWriter((data) => child.write(data))
      writer.write('\x1b[?997;1')
      writer.write('n')
      // Paste-end marker split (the claude stuck-paste initiator).
      writer.write('\x1b[200~hi\x1b[')
      writer.write('201~')
      // A key after all of it must still arrive, in order. (A printable is
      // asserted rather than \x7f because conhost translates a lone DEL into
      // an empty read for this raw-stdin child — equally with or without the
      // guard, so it proves nothing about sequence atomicity.)
      writer.write('z')
      await settle(1200)
      expect(child.received()).toBe('\x1b[?997;1n\x1b[200~hi\x1b[201~z')
      writer.dispose()
    } finally {
      child.kill()
    }
  }, 30000)
})
