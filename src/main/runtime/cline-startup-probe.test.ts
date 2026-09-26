import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Terminal } from '@xterm/headless'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalRead } from '../../shared/runtime-types'
import { observeClineStartup } from './cline-startup-probe'

let tail: string[]
beforeAll(async () => {
  const terminal = new Terminal({ cols: 120, rows: 40, allowProposedApi: true })
  const bytes = readFileSync(join(__dirname, '__fixtures__', 'cline-3-0-65-startup.txt'), 'utf8')
  await new Promise<void>((resolve) => terminal.write(bytes, resolve))
  const buffer = terminal.buffer.active
  tail = Array.from(
    { length: terminal.rows },
    (_, row) => buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? ''
  )
  terminal.dispose()
})
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function screen(overrides: Partial<RuntimeTerminalRead> = {}): RuntimeTerminalRead {
  return {
    handle: 'test',
    status: 'running',
    tail,
    truncated: false,
    nextCursor: null,
    source: 'screen',
    ...overrides
  }
}

async function verdict(snapshot: RuntimeTerminalRead | null): Promise<boolean> {
  const result = observeClineStartup({
    readScreen: async () => snapshot,
    isCurrent: () => true,
    timeoutMs: 3400
  })
  await vi.advanceTimersByTimeAsync(3600)
  return result
}

describe('Cline visible startup probe', () => {
  it('accepts the stable empty composer rendered from real PTY bytes', async () => {
    expect(await verdict(screen())).toBe(true)
  })
  it.each(['ClinePass', 'Sign in', 'Do you trust this folder?', 'Permission required', 'Working'])(
    'refuses a %s overlay',
    async (text) => {
      expect(await verdict(screen({ tail: [...tail, text] }))).toBe(false)
    }
  )
  it('refuses typed input', async () => {
    expect(
      await verdict(
        screen({
          tail: tail.map((line) => line.replace('❯ What can I do for you?', '❯ edit my file'))
        })
      )
    ).toBe(false)
    expect(await verdict(screen({ draft: 'edit my file' }))).toBe(false)
  })
  it.each(['stream', 'screen-unavailable'] as const)('refuses %s provenance', async (source) => {
    expect(await verdict(screen({ source }))).toBe(false)
  })
  it('refuses incomplete or exited snapshots', async () => {
    expect(await verdict(screen({ truncated: true }))).toBe(false)
    expect(await verdict(screen({ limited: true }))).toBe(false)
    expect(await verdict(screen({ status: 'exited' }))).toBe(false)
    expect(await verdict(null)).toBe(false)
  })
  it('does not accept a screen that keeps changing', async () => {
    let count = 0
    const result = observeClineStartup({
      readScreen: async () => screen({ tail: [...tail, ' '.repeat(++count)] }),
      isCurrent: () => true,
      timeoutMs: 3400
    })
    await vi.advanceTimersByTimeAsync(3600)
    expect(await result).toBe(false)
  })
  it('rechecks ownership after the provider responds', async () => {
    let current = true
    expect(
      await observeClineStartup({
        readScreen: async () => {
          current = false
          return screen()
        },
        isCurrent: () => current,
        timeoutMs: 3400
      })
    ).toBe(false)
  })
})
