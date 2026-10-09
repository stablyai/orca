import { EventEmitter } from 'node:events'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assertOrcadServerRuntime,
  handoffToBundledOrcad,
  resolveBundledOrcadSlot
} from './orcad-bundled-runtime'
import {
  NODE_RUNTIME_ASSETS,
  NODE_RUNTIME_COMPAT_ASSETS,
  NODE_RUNTIME_PIN
} from '../../shared/node-runtime-pin'
import {
  ORCAD_NODE_RUNTIME_MARKER_FILENAME,
  ORCAD_SERVER_TARGET_FILENAME,
  ORCAD_VERSION_FILENAME
} from '../../shared/orcad-artifacts'

const TARGET = 'linux-x64-glibc'
const SHA = NODE_RUNTIME_ASSETS[TARGET].executableSha256
const fixture = vi.hoisted(() => ({
  exists: vi.fn<(path: string) => boolean>(),
  read: vi.fn<(path: string) => string>(),
  realpath: vi.fn<(path: string) => string>(),
  spawn: vi.fn()
}))
vi.mock('node:fs', () => ({
  existsSync: fixture.exists,
  readFileSync: fixture.read,
  realpathSync: fixture.realpath
}))
vi.mock('../../shared/child-process/run-process', () => ({ spawnProcess: fixture.spawn }))

class RuntimeChild extends EventEmitter {
  kill = vi.fn()
  disconnect = vi.fn()
  connected = true
}

let child: RuntimeChild
const signalNames = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
let oldListeners: Map<NodeJS.Signals, ReturnType<typeof process.rawListeners>>

beforeEach(() => {
  oldListeners = new Map(signalNames.map((signal) => [signal, process.rawListeners(signal)]))
  child = new RuntimeChild()
  fixture.exists.mockReturnValue(true)
  fixture.read.mockImplementation((path) =>
    path.endsWith(ORCAD_SERVER_TARGET_FILENAME) ? `${TARGET}\n` : `${SHA}\n`
  )
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

  it('refuses a slot whose shared runtime is missing before starting a process', () => {
    fixture.exists.mockImplementation((path) => !path.includes(`node-${SHA}`))
    expect(() => handoffToBundledOrcad()).toThrow('bundled Orca runtime is missing')
    expect(fixture.spawn).not.toHaveBeenCalled()
  })

  it('refuses a slot that names a runtime other than the pinned Node', () => {
    fixture.read.mockImplementation((path) =>
      path.endsWith(ORCAD_SERVER_TARGET_FILENAME) ? `${TARGET}\n` : `${'0'.repeat(64)}\n`
    )
    expect(() => handoffToBundledOrcad()).toThrow(`does not name Node ${NODE_RUNTIME_PIN.version}`)
    expect(fixture.spawn).not.toHaveBeenCalled()
  })

  it('hands a glibc 2.17 compat slot to the compat runtime it names', () => {
    const compatSha = NODE_RUNTIME_COMPAT_ASSETS['linux-x64-glibc217'].executableSha256
    fixture.read.mockImplementation((path) =>
      path.endsWith(ORCAD_SERVER_TARGET_FILENAME) ? 'linux-x64-glibc217\n' : `${compatSha}\n`
    )
    expect(handoffToBundledOrcad()).toBe(true)
    expect(fixture.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        program: join('/slot', '..', 'runtimes', `node-${compatSha}`, 'bin', 'node')
      })
    )
  })

  it('refuses a compat slot that names the default runtime', () => {
    fixture.read.mockImplementation((path) =>
      path.endsWith(ORCAD_SERVER_TARGET_FILENAME) ? 'linux-x64-glibc217\n' : `${SHA}\n`
    )
    expect(() => handoffToBundledOrcad()).toThrow(`does not name Node ${NODE_RUNTIME_PIN.version}`)
  })

  it('refuses a slot without its runtime reference', () => {
    fixture.exists.mockImplementation((path) => !path.endsWith(ORCAD_NODE_RUNTIME_MARKER_FILENAME))
    expect(() => handoffToBundledOrcad()).toThrow('bundled Orca runtime reference is missing')
    expect(fixture.spawn).not.toHaveBeenCalled()
  })

  it('refuses a versioned slot missing both its runtime and target marker', () => {
    fixture.exists.mockImplementation((path) => path.endsWith(ORCAD_VERSION_FILENAME))
    expect(() => handoffToBundledOrcad()).toThrow('bundled Orca runtime target is missing')
    expect(fixture.spawn).not.toHaveBeenCalled()
  })

  it('refuses a remaining runtime reference without its target marker', () => {
    fixture.exists.mockImplementation((path) => !path.endsWith(ORCAD_SERVER_TARGET_FILENAME))
    expect(() => handoffToBundledOrcad()).toThrow('bundled Orca runtime target is missing')
    expect(fixture.realpath).toHaveBeenCalledExactlyOnceWith('/slot/orcad.js')
    expect(fixture.spawn).not.toHaveBeenCalled()
  })

  it('accepts only the pinned version when already executing the bundled runtime', () => {
    fixture.realpath.mockImplementation((path) =>
      path === '/slot/orcad.js' ? path : '/real/runtime'
    )
    vi.spyOn(process, 'versions', 'get').mockReturnValue({
      ...process.versions,
      node: NODE_RUNTIME_PIN.version
    })
    expect(handoffToBundledOrcad()).toBe(false)
    expect(fixture.spawn).not.toHaveBeenCalled()
  })

  it('refuses a runtime path that reports another Node version', () => {
    fixture.realpath.mockImplementation((path) =>
      path === '/slot/orcad.js' ? path : '/real/runtime'
    )
    vi.spyOn(process, 'versions', 'get').mockReturnValue({ ...process.versions, node: '18.0.0' })
    expect(() => handoffToBundledOrcad()).toThrow(`must be Node ${NODE_RUNTIME_PIN.version}`)
  })

  it.each(['linux', 'darwin', 'win32'] as const)(
    'hands off arguments and respects %s signal delivery',
    (platform) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
      expect(handoffToBundledOrcad()).toBe(true)
      expect(fixture.spawn).toHaveBeenCalledWith({
        program: join('/slot', '..', 'runtimes', `node-${SHA}`, 'bin', 'node'),
        args: ['/slot/orcad.js', '--port', '0'],
        env: expect.objectContaining({ ORCA_BUNDLED_LAUNCHER_CHANNEL: '1' }),
        detached: true,
        stdio: ['inherit', 'inherit', 'inherit', 'ipc']
      })
      for (const signal of signalNames) {
        const listener = process
          .rawListeners(signal)
          .find((candidate) => !oldListeners.get(signal)?.includes(candidate))
        if (signal === 'SIGHUP' && platform === 'win32') {
          expect(listener).toBeUndefined()
          continue
        }
        expect(listener).toBeDefined()
        if (listener) {
          listener.call(process, signal)
        }
        if (signal === 'SIGHUP') {
          expect(child.kill).not.toHaveBeenCalledWith('SIGHUP')
        } else if (platform === 'win32') {
          expect(child.kill).not.toHaveBeenCalled()
          expect(child.disconnect).toHaveBeenCalled()
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

  it('locates the runtime beside the resolved entry rather than its symlink', () => {
    fixture.realpath.mockImplementation((path) =>
      path === '/slot/orcad.js' ? '/real/slot/orcad.js' : path
    )
    handoffToBundledOrcad()
    expect(fixture.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        program: join('/real/slot', '..', 'runtimes', `node-${SHA}`, 'bin', 'node'),
        args: ['/real/slot/orcad.js', '--port', '0']
      })
    )
  })

  it('resolves the slot a symlinked entry lives in, as the handoff does', () => {
    fixture.realpath.mockImplementation((path) =>
      path === '/bin/orcad.js' ? '/real/slot/orcad.js' : path
    )
    expect(resolveBundledOrcadSlot('/bin/orcad.js')).toBe(resolve('/real/slot'))
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

describe('server runtime admission', () => {
  it.each(['18.20.8', '20.19.0', '22.14.0', '23.0.0'])(
    'refuses host Node %s before loading profile state',
    (node) => {
      fixture.exists.mockReturnValue(false)
      vi.spyOn(process, 'versions', 'get').mockReturnValue({ ...process.versions, node })
      expect(() => assertOrcadServerRuntime()).toThrow('requires Node.js 24')
    }
  )

  it.each(['24.0.0', '26.0.0'])('accepts unpackaged host Node %s', (node) => {
    fixture.exists.mockReturnValue(false)
    vi.spyOn(process, 'versions', 'get').mockReturnValue({ ...process.versions, node })
    expect(() => assertOrcadServerRuntime()).not.toThrow()
  })

  it('refuses host Node 24 for a packaged slot that owns a bundled runtime', () => {
    vi.spyOn(process, 'versions', 'get').mockReturnValue({ ...process.versions, node: '24.0.0' })
    expect(() => assertOrcadServerRuntime()).toThrow('Start the Orca server with its bundled')
  })

  it('accepts the packaged runtime only at its pinned version', () => {
    fixture.realpath.mockImplementation((path) =>
      path === '/slot/orcad.js' ? path : '/real/runtime'
    )
    const versions = vi.spyOn(process, 'versions', 'get')
    versions.mockReturnValue({ ...process.versions, node: '24.0.0' })
    expect(() => assertOrcadServerRuntime()).toThrow(`must be Node ${NODE_RUNTIME_PIN.version}`)
    versions.mockReturnValue({ ...process.versions, node: NODE_RUNTIME_PIN.version })
    expect(() => assertOrcadServerRuntime()).not.toThrow()
  })
})
