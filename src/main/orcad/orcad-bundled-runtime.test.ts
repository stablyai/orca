import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handoffToBundledOrcad } from './orcad-bundled-runtime'
import { ORCAD_BUN_VERSION } from '../../shared/orcad-bun-runtime'

const fixture = vi.hoisted(() => ({
  exists: vi.fn<(path: string) => boolean>(),
  realpath: vi.fn<(path: string) => string>(),
  spawn: vi.fn()
}))
vi.mock('node:fs', () => ({ existsSync: fixture.exists, realpathSync: fixture.realpath }))
vi.mock('../../shared/child-process/run-process', () => ({ spawnProcess: fixture.spawn }))

class RuntimeChild extends EventEmitter {
  kill = vi.fn()
}

let child: RuntimeChild
const signalNames = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
let oldListeners: Map<NodeJS.Signals, ReturnType<typeof process.rawListeners>>

beforeEach(() => {
  oldListeners = new Map(signalNames.map((signal) => [signal, process.rawListeners(signal)]))
  child = new RuntimeChild()
  fixture.exists.mockReturnValue(true)
  fixture.realpath.mockImplementation((path) => path)
  fixture.spawn.mockReturnValue(child)
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('test process exit')
  })
  vi.spyOn(process, 'kill').mockReturnValue(true)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(process, 'argv', 'get').mockReturnValue(['/node', '/slot/orcad.js', '--port', '0'])
})

afterEach(() => {
  for (const signal of signalNames) {
    for (const listener of process.rawListeners(signal)) {
      if (!oldListeners.get(signal)?.includes(listener)) {
        process.off(signal, listener)
      }
    }
  }
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('bundled Orca runtime handoff', () => {
  it('leaves nonpackaged entries on their existing runtime', () => {
    fixture.exists.mockReturnValue(false)
    expect(handoffToBundledOrcad()).toBe(false)
    expect(fixture.spawn).not.toHaveBeenCalled()
  })

  it('refuses an incomplete slot before starting a process', () => {
    fixture.exists.mockImplementation((path) => path.endsWith('.build-target'))
    expect(() => handoffToBundledOrcad()).toThrow('bundled Orca runtime is missing')
    expect(fixture.spawn).not.toHaveBeenCalled()
  })

  it('refuses a remaining bundled runtime without its target marker', () => {
    fixture.exists.mockImplementation((path) => !path.endsWith('.build-target'))
    expect(() => handoffToBundledOrcad()).toThrow('bundled Orca runtime target is missing')
    expect(fixture.realpath).not.toHaveBeenCalled()
    expect(fixture.spawn).not.toHaveBeenCalled()
  })

  it('accepts only the pinned version when already executing the bundled runtime', () => {
    fixture.realpath.mockReturnValue('/real/runtime')
    vi.spyOn(process, 'versions', 'get').mockReturnValue({
      ...process.versions,
      bun: ORCAD_BUN_VERSION
    })
    expect(handoffToBundledOrcad()).toBe(false)
    expect(fixture.spawn).not.toHaveBeenCalled()
  })

  it('refuses an adjacent runtime that reports the wrong Bun version', () => {
    fixture.realpath.mockReturnValue('/real/runtime')
    vi.spyOn(process, 'versions', 'get').mockReturnValue({ ...process.versions, bun: '0.0.0' })
    expect(() => handoffToBundledOrcad()).toThrow(`must be Bun ${ORCAD_BUN_VERSION}`)
  })

  it.each(['linux', 'darwin', 'win32'] as const)(
    'hands off arguments and respects %s signal delivery',
    (platform) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
      expect(handoffToBundledOrcad()).toBe(true)
      expect(fixture.spawn).toHaveBeenCalledWith({
        program: expect.stringMatching(/bun-runtime(?:\.exe)?$/),
        args: ['/slot/orcad.js', '--port', '0'],
        stdio: 'inherit'
      })
      for (const signal of signalNames) {
        const listener = process
          .rawListeners(signal)
          .find((candidate) => !oldListeners.get(signal)?.includes(candidate))
        expect(listener).toBeDefined()
        if (listener) {
          listener.call(process, signal)
        }
        if (platform === 'win32') {
          expect(child.kill).not.toHaveBeenCalled()
        } else {
          expect(child.kill).toHaveBeenLastCalledWith(signal)
        }
      }
    }
  )

  it('propagates a child exit code and removes every signal listener', () => {
    handoffToBundledOrcad()
    expect(() => child.emit('exit', 23, null)).toThrow('test process exit')
    expect(process.exit).toHaveBeenCalledWith(23)
    expect(process.kill).not.toHaveBeenCalled()
    for (const signal of signalNames) {
      expect(process.rawListeners(signal)).toEqual(oldListeners.get(signal))
    }
  })

  it('reports failed spawn as a configuration failure and removes listeners', () => {
    handoffToBundledOrcad()
    expect(() => child.emit('error', new Error('ENOENT'))).toThrow('test process exit')
    expect(process.exit).toHaveBeenCalledWith(78)
    for (const signal of signalNames) {
      expect(process.rawListeners(signal)).toEqual(oldListeners.get(signal))
    }
  })

  it('mirrors a POSIX signal exit without exiting before the signal is delivered', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    handoffToBundledOrcad()
    child.emit('exit', null, 'SIGTERM')
    expect(process.kill).toHaveBeenCalledWith(process.pid, 'SIGTERM')
    expect(process.exit).not.toHaveBeenCalled()
  })

  it('preserves a signal exit without sending unsupported signals on Windows', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    handoffToBundledOrcad()
    expect(() => child.emit('exit', null, 'SIGTERM')).toThrow('test process exit')
    expect(process.exit).toHaveBeenCalledWith(143)
    expect(process.kill).not.toHaveBeenCalled()
  })
})
