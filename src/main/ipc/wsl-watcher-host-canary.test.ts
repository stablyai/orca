import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWatcherBindingWatchdog } from './wsl-watcher-host-binding-watchdog'
import {
  startWslWatcherCanary,
  sweepStaleWslWatcherCanaryDirectories
} from './wsl-watcher-host-canary'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function expectRealExitCleansCanary(stall: 'subscribe' | 'unsubscribe'): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'orca-canary-exit-test-'))
  const runner = join(root, 'runner.cjs')
  const report = join(root, 'canary-dir.txt')
  const canaryModule = resolve('src/main/ipc/wsl-watcher-host-canary.ts').replaceAll('\\', '/')
  const watchdogModule = resolve('src/main/ipc/wsl-watcher-host-binding-watchdog.ts').replaceAll(
    '\\',
    '/'
  )
  let canaryDir = ''
  try {
    await build({
      bundle: true,
      format: 'cjs',
      outfile: runner,
      platform: 'node',
      stdin: {
        contents: `
            import { writeFileSync } from 'node:fs'
            import { startWslWatcherCanary } from ${JSON.stringify(canaryModule)}
            import { createWatcherBindingWatchdog } from ${JSON.stringify(watchdogModule)}
            const keepAlive = setInterval(() => undefined, 1_000)
            const stall = ${JSON.stringify(stall)}
            const binding = {
              subscribe: (dir) => {
                writeFileSync(process.argv[2], dir)
                return stall === 'subscribe' ? new Promise(() => undefined) : Promise.resolve()
              },
              unsubscribe: () =>
                stall === 'unsubscribe' ? new Promise(() => undefined) : Promise.resolve()
            }
            void startWslWatcherCanary(
              binding,
              createWatcherBindingWatchdog((code) => process.exit(code), 10)
            )
              .then((canary) => stall === 'unsubscribe' ? canary.close() : undefined)
              .finally(() => clearInterval(keepAlive))
          `,
        loader: 'ts',
        resolveDir: process.cwd(),
        sourcefile: 'canary-exit-runner.ts'
      }
    })
    const child = spawn(process.execPath, [runner, report], { stdio: 'ignore' })
    const exitCode = await new Promise<number | null>((resolvePromise, rejectPromise) => {
      child.once('error', rejectPromise)
      child.once('exit', resolvePromise)
    })
    canaryDir = await readFile(report, 'utf8')

    expect(exitCode).toBe(4)
    expect(existsSync(canaryDir)).toBe(false)
  } finally {
    if (canaryDir) {
      await rm(canaryDir, { recursive: true, force: true })
    }
    await rm(root, { recursive: true, force: true })
  }
}

describe('WSL watcher host canary', () => {
  it('removes its directory when the real host exits before subscribe settles', async () => {
    await expectRealExitCleansCanary('subscribe')
  })

  it('removes its directory when real host exit interrupts unsubscribe', async () => {
    await expectRealExitCleansCanary('unsubscribe')
  })

  it('recycles the host and removes its directory when subscribe never settles', async () => {
    vi.useFakeTimers()
    const exit = vi.fn()
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    let canaryDir = ''
    const binding = {
      subscribe: vi.fn((dir: string) => {
        canaryDir = dir
        return new Promise<void>(() => undefined)
      }),
      unsubscribe: vi.fn(async () => undefined)
    }
    const started = startWslWatcherCanary(binding, createWatcherBindingWatchdog(exit, 10))
    const rejected = expect(started).rejects.toThrow('Native watcher canary subscribe timed out')

    await vi.advanceTimersByTimeAsync(10)

    expect(exit).toHaveBeenCalledWith(4)
    await rejected
    expect(canaryDir).not.toBe('')
    expect(existsSync(canaryDir)).toBe(false)
  })

  it('recycles the host and cleans all resources when unsubscribe never settles', async () => {
    vi.useFakeTimers()
    const exit = vi.fn()
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    let canaryDir = ''
    const binding = {
      subscribe: vi.fn(async (dir: string) => {
        canaryDir = dir
      }),
      unsubscribe: vi.fn(() => new Promise<void>(() => undefined))
    }
    const listenerCount = process.listenerCount('exit')
    const canary = await startWslWatcherCanary(binding, createWatcherBindingWatchdog(exit, 10))
    const closing = canary.close()
    const rejected = expect(closing).rejects.toThrow('Native watcher canary unsubscribe timed out')

    await vi.advanceTimersByTimeAsync(10)

    expect(exit).toHaveBeenCalledWith(4)
    await rejected
    expect(existsSync(canaryDir)).toBe(false)
    expect(process.listenerCount('exit')).toBe(listenerCount)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('sweeps only dead-owner canary directories at host start', async () => {
    const base = await mkdtemp(join(tmpdir(), 'orca-canary-sweep-test-'))
    try {
      const stale = join(base, 'orca-wsl-watcher-4242-abc123')
      const live = join(base, 'orca-wsl-watcher-5151-def456')
      const own = join(base, `orca-wsl-watcher-${process.pid}-ghi789`)
      const unrelated = join(base, 'orca-wsl-watcher-legacyname')
      for (const dir of [stale, live, own, unrelated]) {
        mkdirSync(dir)
      }

      sweepStaleWslWatcherCanaryDirectories(base, (pid) => pid === 5151)

      expect(existsSync(stale)).toBe(false)
      expect(existsSync(live)).toBe(true)
      expect(existsSync(own)).toBe(true)
      expect(existsSync(unrelated)).toBe(true)
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  it('unsubscribes and cleans resources on an ordinary close', async () => {
    vi.useFakeTimers()
    let canaryDir = ''
    let callback: ((error: Error | null) => void) | undefined
    const binding = {
      subscribe: vi.fn(async (dir: string, subscribedCallback: (error: Error | null) => void) => {
        canaryDir = dir
        callback = subscribedCallback
      }),
      unsubscribe: vi.fn(async () => undefined)
    }
    const listenerCount = process.listenerCount('exit')
    const canary = await startWslWatcherCanary(binding, createWatcherBindingWatchdog(vi.fn(), 10))

    await canary.close()
    await canary.close()

    expect(binding.unsubscribe).toHaveBeenCalledOnce()
    expect(binding.unsubscribe).toHaveBeenCalledWith(canaryDir, callback, {})
    expect(existsSync(canaryDir)).toBe(false)
    expect(process.listenerCount('exit')).toBe(listenerCount)
    expect(vi.getTimerCount()).toBe(0)
  })
})
