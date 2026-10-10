import { afterEach, describe, expect, it, vi } from 'vitest'
import { HeadlessEmulator } from './headless-emulator'
import { PreparedSessionHistorySeed } from './session-output-plane'
import { TerminalHost } from './terminal-host'
import type { SubprocessHandle } from './session-subprocess-handle'

import './mock-descendant-sweep'

afterEach(() => vi.restoreAllMocks())

function subprocess(prompt = '') {
  let exit: ((code: number) => void) | undefined
  return {
    pid: 4242,
    getForegroundProcess: () => null,
    write: vi.fn(),
    resize() {},
    signal() {},
    kill() {
      exit?.(0)
    },
    forceKill() {
      exit?.(137)
    },
    terminateOwnedTree: () => 'unavailable' as const,
    onData(listener: (data: string) => void) {
      if (prompt) {
        listener(prompt)
      }
    },
    onExit(listener: (code: number) => void) {
      exit = listener
    },
    dispose() {}
  } satisfies SubprocessHandle
}

function options(sessionId: string, historySeedChunks?: readonly string[]) {
  return {
    sessionId,
    cols: 80,
    rows: 24,
    historySeedChunks,
    streamClient: { onData() {}, onExit() {} }
  }
}

const largeSeed = [`RESTORED\r\n${'x'.repeat(256 * 1024)}\r\nLAST\r\n`]

describe('TerminalHost history replay before native spawn', () => {
  it('starts an ordinary child immediately without preparing history', async () => {
    const prepare = vi.spyOn(PreparedSessionHistorySeed, 'create')
    const spawn = vi.fn(() => subprocess())
    const host = new TerminalHost({ spawnSubprocess: spawn })
    try {
      const creation = host.createOrAttach(options('ordinary'))
      expect(spawn).toHaveBeenCalledOnce()
      expect(prepare).not.toHaveBeenCalled()
      expect((await creation).historySeeded).toBeUndefined()
    } finally {
      await host.dispose()
    }
  })

  it('yields to existing input before spawning and seeds before synchronous prompt delivery', async () => {
    const live = subprocess()
    const restored = subprocess('PROMPT\r\n')
    const spawn = vi.fn().mockReturnValueOnce(live).mockReturnValueOnce(restored)
    const host = new TerminalHost({ spawnSubprocess: spawn })
    try {
      await host.createOrAttach(options('live'))
      let inputRan = false
      setImmediate(() => {
        host.write('live', 'a')
        inputRan = true
      })
      const creation = host.createOrAttach(options('restore', largeSeed))
      expect(spawn).toHaveBeenCalledOnce()
      expect((await creation).historySeeded).toBe(true)
      expect(inputRan).toBe(true)
      expect(live.write).toHaveBeenCalledExactlyOnceWith('a')
      expect(host.getSnapshot('restore')?.snapshotAnsi).toContain('LAST\r\nPROMPT')
    } finally {
      await host.dispose()
    }
  })

  it('retains the same-id creation claim throughout replay', async () => {
    const spawn = vi.fn(() => subprocess())
    const host = new TerminalHost({ spawnSubprocess: spawn })
    try {
      const first = host.createOrAttach(options('same', largeSeed))
      const second = host.createOrAttach(options('same', largeSeed))
      const results = await Promise.all([first, second])
      expect(results.map((result) => result.isNew)).toEqual([true, false])
      expect(spawn).toHaveBeenCalledOnce()
    } finally {
      await host.dispose()
    }
  })

  it('cancels between replay turns without spawning and releases history', async () => {
    const controller = new AbortController()
    const spawn = vi.fn(() => subprocess())
    const host = new TerminalHost({ spawnSubprocess: spawn })
    const dispose = vi.spyOn(HeadlessEmulator.prototype, 'dispose')
    setImmediate(() => controller.abort())
    const creation = host.createOrAttach({
      ...options('cancel', largeSeed),
      cancelSignal: controller.signal,
      isCanceled: () => controller.signal.aborted
    })
    await expect(creation).rejects.toThrow('canceled')
    expect(spawn).not.toHaveBeenCalled()
    expect(dispose).toHaveBeenCalledOnce()
    await host.dispose()
  })

  it('stops pending replay when the host begins shutting down', async () => {
    const spawn = vi.fn(() => subprocess())
    const host = new TerminalHost({ spawnSubprocess: spawn })
    const dispose = vi.spyOn(HeadlessEmulator.prototype, 'dispose')
    const creation = host.createOrAttach(options('shutdown', largeSeed))
    const rejection = expect(creation).rejects.toThrow('shutting down')
    await host.dispose()
    await rejection
    expect(spawn).not.toHaveBeenCalled()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('disposes a prepared seed after spawn failure and releases the same-id claim', async () => {
    const spawn = vi
      .fn()
      .mockRejectedValueOnce(new Error('spawn failed'))
      .mockReturnValueOnce(subprocess())
    const host = new TerminalHost({ spawnSubprocess: spawn })
    const dispose = vi.spyOn(HeadlessEmulator.prototype, 'dispose')
    try {
      await expect(host.createOrAttach(options('retry', largeSeed))).rejects.toThrow('spawn failed')
      expect(dispose).toHaveBeenCalledOnce()
      expect((await host.createOrAttach(options('retry'))).isNew).toBe(true)
    } finally {
      await host.dispose()
    }
  })
})
