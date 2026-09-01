import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setAppEnvironment, type AppEnvironment } from '../../shared/app-environment'
import {
  canForkDaemonThroughUtilityProcess,
  forkDaemonThroughUtilityProcess,
  setDaemonUtilityProcessFork,
  type UtilityProcessForkFn,
  type UtilityProcessLike
} from './daemon-utility-process-fork'
import type { DaemonShimDownMessage, UtilityDaemonForkSpec } from './daemon-utility-fork-messages'

class FakeShim extends EventEmitter implements UtilityProcessLike {
  pid = 999
  posted: DaemonShimDownMessage[] = []
  killed = false
  postMessage(message: unknown): void {
    this.posted.push(message as DaemonShimDownMessage)
  }
  kill(): boolean {
    this.killed = true
    return true
  }
}

const SPEC: UtilityDaemonForkSpec = {
  entryPath: '/fake/daemon-entry.js',
  args: ['--socket', '/fake/sock'],
  cwd: '/fake/userData',
  env: { ELECTRON_RUN_AS_NODE: '1' },
  execPath: '/fake/electron'
}

let shim: FakeShim
let forkedPaths: string[]

let forkOptions: (Record<string, unknown> | undefined)[]

const forkFn: UtilityProcessForkFn = (modulePath, _args, options) => {
  forkedPaths.push(modulePath)
  forkOptions.push(options)
  return shim
}

/** Runs the handshake to a resolved child: shim-ready -> spawn -> spawned. */
async function forkSettledChild() {
  const promise = forkDaemonThroughUtilityProcess(SPEC, forkFn)
  shim.emit('message', { kind: 'shim-ready' })
  shim.emit('message', { kind: 'spawned', pid: 777 })
  return await promise
}

function setFakeAppEnvironment(appPath: string): void {
  setAppEnvironment({
    getAppPath: () => appPath,
    getPath: () => '/fake/userData',
    getVersion: () => '1.2.3',
    isPackaged: () => false,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  } as unknown as AppEnvironment)
}

/** Runs a body against a throwaway bundle root so shim-path resolution is real. */
function withBundleRoot(body: (appPath: string) => Promise<void>): Promise<void> {
  const appPath = mkdtempSync(join(tmpdir(), 'orca-shim-path-'))
  setFakeAppEnvironment(appPath)
  return body(appPath).finally(() => rmSync(appPath, { recursive: true, force: true }))
}

beforeEach(() => {
  shim = new FakeShim()
  forkedPaths = []
  forkOptions = []
  setFakeAppEnvironment('/fake/app')
})

afterEach(() => {
  vi.useRealTimers()
  setDaemonUtilityProcessFork(null)
})

describe('canForkDaemonThroughUtilityProcess', () => {
  it('never uses the utility hop on macOS: posix_spawn already strips descriptors and TCC needs the direct fork', () => {
    setDaemonUtilityProcessFork(forkFn)
    expect(canForkDaemonThroughUtilityProcess('darwin')).toBe(false)
  })

  it('uses the utility hop on Linux and Windows once the desktop installs the port', () => {
    setDaemonUtilityProcessFork(forkFn)
    expect(canForkDaemonThroughUtilityProcess('linux')).toBe(true)
    expect(canForkDaemonThroughUtilityProcess('win32')).toBe(true)
  })

  it('declines on hosts that install no port (plain-node serve)', () => {
    expect(canForkDaemonThroughUtilityProcess('linux')).toBe(false)
    expect(canForkDaemonThroughUtilityProcess('win32')).toBe(false)
  })

  it('warns when an ELECTRON host has no port: a dropped bootstrap install is a silent revert to the leaky fork', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(canForkDaemonThroughUtilityProcess('linux', { electron: '37.2.0' })).toBe(false)
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('No utility-process fork installed')
      )
      warnSpy.mockClear()
      // Plain-node serve installs nothing by design; macOS never takes the hop. Both stay quiet.
      expect(canForkDaemonThroughUtilityProcess('linux', {})).toBe(false)
      expect(canForkDaemonThroughUtilityProcess('darwin', { electron: '37.2.0' })).toBe(false)
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('forkDaemonThroughUtilityProcess', () => {
  it('forks the shim entry and hands it the spawn spec over postMessage, never argv', async () => {
    const child = await forkSettledChild()
    expect(forkedPaths[0]).toContain('daemon-utility-launcher-shim.js')
    expect(shim.posted).toEqual([{ kind: 'spawn', spec: SPEC }])
    expect(child.pid).toBe(777)
    expect(child.connected).toBe(true)
  })

  it('relays daemon IPC messages, stderr, and exit through the ChildProcess surface', async () => {
    const child = await forkSettledChild()
    const messages: unknown[] = []
    const stderrChunks: string[] = []
    const exits: [number | null, NodeJS.Signals | null][] = []
    child.on('message', (message) => messages.push(message))
    child.stderr?.on('data', (chunk) => stderrChunks.push(chunk.toString('utf8')))
    child.on('exit', (code, signal) => exits.push([code, signal]))

    shim.emit('message', { kind: 'daemon-message', message: { type: 'ready' } })
    shim.emit('message', { kind: 'daemon-stderr', text: 'boom trace' })
    shim.emit('message', { kind: 'daemon-exit', code: 1, signal: null })

    expect(messages).toEqual([{ type: 'ready' }])
    expect(stderrChunks).toEqual(['boom trace'])
    expect(exits).toEqual([[1, null]])
    expect(child.exitCode).toBe(1)
    // Nothing left to relay once the daemon is gone.
    expect(shim.killed).toBe(true)
  })

  it('rejects when the shim reports a spawn failure', async () => {
    const promise = forkDaemonThroughUtilityProcess(SPEC, forkFn)
    shim.emit('message', { kind: 'shim-ready' })
    shim.emit('message', { kind: 'spawn-error', message: 'ENOENT' })
    await expect(promise).rejects.toThrow('ENOENT')
    expect(shim.killed).toBe(true)
  })

  it('rejects when the shim dies during the handshake', async () => {
    const promise = forkDaemonThroughUtilityProcess(SPEC, forkFn)
    shim.emit('message', { kind: 'shim-ready' })
    shim.emit('exit', 1)
    await expect(promise).rejects.toThrow('exited during the launch handshake')
  })

  it('rejects when the shim never answers', async () => {
    vi.useFakeTimers()
    const promise = forkDaemonThroughUtilityProcess(SPEC, forkFn)
    const assertion = expect(promise).rejects.toThrow('handshake timed out')
    await vi.advanceTimersByTimeAsync(10_001)
    await assertion
    expect(shim.killed).toBe(true)
  })

  it('fails an unsettled handshake on the utility process error event instead of crashing main', async () => {
    const promise = forkDaemonThroughUtilityProcess(SPEC, forkFn)
    shim.emit('message', { kind: 'shim-ready' })
    // Electron forwards V8 fatal errors through EventEmitter 'error'; with no
    // listener that is an uncaught exception in the main process, thrown before
    // the launcher ever sees the handshake rejection.
    expect(() => shim.emit('error', 'FatalError', 'v8::internal::Heap', '{}')).not.toThrow()
    await expect(promise).rejects.toThrow('FatalError')
    expect(shim.killed).toBe(true)
  })

  it('routes no late shim events to the orphan child after a rejected launch', async () => {
    vi.useFakeTimers()
    const promise = forkDaemonThroughUtilityProcess(SPEC, forkFn)
    const assertion = expect(promise).rejects.toThrow('handshake timed out')
    await vi.advanceTimersByTimeAsync(10_001)
    await assertion
    // The rejected launch was the only consumer — the child was never handed
    // out, so a relayed 'error' emission has no listener and would crash main.
    expect(() => shim.emit('exit', 1)).not.toThrow()
    expect(() =>
      shim.emit('message', { kind: 'daemon-error', message: 'late failure' })
    ).not.toThrow()
  })

  it('surfaces an unexpected shim death after launch as a child error', async () => {
    const child = await forkSettledChild()
    const errors: Error[] = []
    child.on('error', (error) => errors.push(error))
    shim.emit('exit', 1)
    expect(errors).toHaveLength(1)
    // Exact: with no fatal error recorded the message must not trail a cause.
    expect(errors[0].message).toBe('Daemon utility launcher exited before the daemon settled')
  })

  it('carries a post-launch fatal shim error into the child error as the cause', async () => {
    const child = await forkSettledChild()
    const errors: Error[] = []
    child.on('error', (error) => errors.push(error))
    // Electron emits 'error' then 'exit'; failing the settled launch again would
    // drop the cause, leaving only "exited before the daemon settled" to triage.
    shim.emit('error', 'FatalError', 'v8::internal::Heap', '{}')
    shim.emit('exit', 1)
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toBe(
      'Daemon utility launcher exited before the daemon settled: Daemon utility launcher hit a fatal error: FatalError at v8::internal::Heap'
    )
  })

  it('suppresses late daemon-error relays after release: no listener remains to catch them', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const child = await forkSettledChild()
      child.disconnect()
      // Would be an uncaught exception if emitted with no 'error' listener.
      expect(() =>
        shim.emit('message', { kind: 'daemon-error', message: 'late failure' })
      ).not.toThrow()
      // The launch already succeeded and the daemon is detached; degrading this
      // to the no-listener warn would log a launch failure that did not happen.
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('treats the shim exit that follows a relayed daemon exit as shutdown, not a launch failure', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await forkSettledChild()
      shim.emit('message', { kind: 'daemon-exit', code: 1, signal: null })
      expect(shim.killed).toBe(true)
      // Electron emits 'exit' after that kill(), by which point the launcher has
      // already dropped its startup listeners and reported the real exit code.
      shim.emit('exit', 0)
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('releases a shim that is already gone without throwing out of disconnect', async () => {
    const child = await forkSettledChild()
    // Reachable: a daemon that dies during startup makes the exit relay kill the
    // shim, and the launcher's cleanup path still calls disconnect() afterwards.
    shim.postMessage = () => {
      throw new Error('Utility process is not running')
    }
    expect(() => child.disconnect()).not.toThrow()
    expect(child.connected).toBe(false)
  })

  // Pre-guard, every leg below re-raised as [main_uncaught_exception]: the relay
  // emitted 'error' on a child no caller ever received, and an unlistened
  // EventEmitter 'error' throws.
  describe('failed-handshake crash guard', () => {
    it('a shim exit after a rejected handshake degrades to a warn instead of crashing main', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const promise = forkDaemonThroughUtilityProcess(SPEC, forkFn)
        shim.emit('message', { kind: 'shim-ready' })
        shim.emit('message', { kind: 'spawn-error', message: 'ENOENT' })
        await expect(promise).rejects.toThrow('ENOENT')
        expect(() => shim.emit('exit', 1)).not.toThrow()
        expect(warnSpy).toHaveBeenCalled()
      } finally {
        warnSpy.mockRestore()
      }
    })

    it('a shim exit after a handshake timeout degrades instead of crashing main', async () => {
      vi.useFakeTimers()
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const promise = forkDaemonThroughUtilityProcess(SPEC, forkFn)
        const assertion = expect(promise).rejects.toThrow('handshake timed out')
        await vi.advanceTimersByTimeAsync(10_001)
        await assertion
        expect(() => shim.emit('exit', 1)).not.toThrow()
      } finally {
        warnSpy.mockRestore()
      }
    })

    it('a late daemon-error relay after a rejected handshake degrades instead of crashing main', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const promise = forkDaemonThroughUtilityProcess(SPEC, forkFn)
        shim.emit('message', { kind: 'shim-ready' })
        shim.emit('message', { kind: 'spawn-error', message: 'ENOENT' })
        await expect(promise).rejects.toThrow('ENOENT')
        expect(() =>
          shim.emit('message', { kind: 'daemon-error', message: 'late failure' })
        ).not.toThrow()
      } finally {
        warnSpy.mockRestore()
      }
    })
  })

  it('forks through the port the desktop installed when called with a spec alone', async () => {
    // The only shape production uses: daemon-init passes no fork argument.
    setDaemonUtilityProcessFork(forkFn)
    const promise = forkDaemonThroughUtilityProcess(SPEC)
    shim.emit('message', { kind: 'shim-ready' })
    shim.emit('message', { kind: 'spawned', pid: 777 })
    await expect(promise).resolves.toMatchObject({ pid: 777 })
    expect(forkedPaths).toHaveLength(1)
  })

  it('gives the shim no inheritable stdio and a named service entry', async () => {
    await forkSettledChild()
    // 'ignore': nobody drains the shim's output, and an unread pipe from main
    // both blocks exit and hands the shim descriptors this hop exists to avoid.
    expect(forkOptions[0]).toEqual({ stdio: 'ignore', serviceName: 'orca-daemon-launcher' })
  })

  it('rejects by name when no port is installed rather than throwing a bare TypeError', async () => {
    await expect(forkDaemonThroughUtilityProcess(SPEC)).rejects.toThrow(
      'No utility-process fork is installed on this host'
    )
  })

  it('resolves the shim under out/main, the layout every host taking the hop ships', async () => {
    await withBundleRoot(async (appPath) => {
      await forkSettledChild()
      expect(forkedPaths[0]).toBe(join(appPath, 'out', 'main', 'daemon-utility-launcher-shim.js'))
    })
  })

  it('prefers a shim sitting directly in the bundle root when one is there', async () => {
    await withBundleRoot(async (appPath) => {
      writeFileSync(join(appPath, 'daemon-utility-launcher-shim.js'), '')
      await forkSettledChild()
      expect(forkedPaths[0]).toBe(join(appPath, 'daemon-utility-launcher-shim.js'))
    })
  })

  it('disconnect releases the shim instead of killing the daemon', async () => {
    const child = await forkSettledChild()
    const errors: Error[] = []
    child.on('error', (error) => errors.push(error))
    child.disconnect()
    expect(child.connected).toBe(false)
    expect(shim.posted).toContainEqual({ kind: 'release' })
    // The shim exiting after release is the expected shutdown, not a failure.
    shim.emit('exit', 0)
    expect(errors).toEqual([])
  })
})
