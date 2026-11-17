import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import { classifyNodePtyLoaderMessage } from './node-pty-loader-diagnosis'

// Exercises the loader added by config/patches/node-pty@1.1.0.patch, not a copy of it.
const require = createRequire(import.meta.url)
const PATCHED_UTILS = join(dirname(require.resolve('node-pty/package.json')), 'lib', 'utils.js')
const WIN_DIRS = 'build/orca-napi-win32-x64, build/Release, build/Debug, prebuilds/win32-x64'
const SHARING_VIOLATION =
  'The process cannot access the file because it is being used by another process.'

type LoadNativeModule = (name: string) => unknown

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function loadPatchedUtilsCopy(nativeFiles: Record<string, string> = {}): LoadNativeModule {
  const root = mkdtempSync(join(tmpdir(), 'orca-node-pty-load-'))
  tempDirs.push(root)
  mkdirSync(join(root, 'lib'))
  copyFileSync(PATCHED_UTILS, join(root, 'lib', 'utils.js'))
  for (const [relativePath, contents] of Object.entries(nativeFiles)) {
    mkdirSync(dirname(join(root, relativePath)), { recursive: true })
    writeFileSync(join(root, relativePath), contents)
  }
  const utils: { loadNativeModule: LoadNativeModule } = require(join(root, 'lib', 'utils.js'))
  return utils.loadNativeModule
}

/** Runs the installed loader with a scripted require and a faked platform, recording retry waits. */
function loadPatchedUtilsWithRequire(
  platform: string,
  fakeRequire: (path: string) => unknown
): { loadNativeModule: LoadNativeModule; requested: string[]; waits: number[] } {
  const requested: string[] = []
  const waits: number[] = []
  const moduleExports: { loadNativeModule?: LoadNativeModule } = {}
  const wrapper = runInNewContext(
    `(function (exports, require) {${readFileSync(PATCHED_UTILS, 'utf8')}\n})`,
    {
      process: { platform, arch: 'x64' },
      Atomics: {
        wait: (_array: unknown, _index: number, _value: number, ms: number) => waits.push(ms)
      },
      Error,
      Object
    }
  )
  wrapper(moduleExports, (path: string) => {
    requested.push(path)
    return fakeRequire(path)
  })
  const { loadNativeModule } = moduleExports
  if (typeof loadNativeModule !== 'function') {
    throw new Error('patched utils.js did not export loadNativeModule')
  }
  return { loadNativeModule, requested, waits }
}

function loadError(loadNativeModule: LoadNativeModule, name: string): string {
  try {
    loadNativeModule(name)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error(`expected ${name}.node to fail to load`)
}

function dlopenError(message: string): Error {
  return Object.assign(new Error(message), { code: 'ERR_DLOPEN_FAILED' })
}

function notFound(path: string): Error {
  return Object.assign(new Error(`Cannot find module '${path}'`), { code: 'MODULE_NOT_FOUND' })
}

describe('patched node-pty native module loader', () => {
  it('keeps the real load failure instead of the final missing prebuilds directory', () => {
    const loadNativeModule = loadPatchedUtilsCopy({
      'build/Release/broken.node': 'not a native module'
    })

    const message = loadError(loadNativeModule, 'broken')

    expect(message).toMatch(/^Failed to load native module: broken\.node, checked: /)
    expect(message).toContain('../build/Release/broken.node (ERR_DLOPEN_FAILED): ')
    expect(message).not.toContain('Cannot find module')
  })

  it('retries a Windows sharing violation once and returns the module when it then loads', () => {
    const conpty = { name: 'conpty' }
    let releaseAttempts = 0
    const { loadNativeModule, requested, waits } = loadPatchedUtilsWithRequire('win32', (path) => {
      if (path !== '../build/Release/conpty.node') {
        throw notFound(path)
      }
      releaseAttempts += 1
      if (releaseAttempts === 1) {
        throw dlopenError(SHARING_VIOLATION)
      }
      return conpty
    })

    expect(loadNativeModule('conpty')).toEqual({ dir: '../build/Release/', module: conpty })
    expect(waits).toEqual([200])
    expect(requested.filter((path) => path === '../build/Release/conpty.node')).toHaveLength(2)
  })

  it('reports both the first failure and the retry failure, then stops', () => {
    const { loadNativeModule, requested, waits } = loadPatchedUtilsWithRequire('win32', (path) => {
      throw path === '../build/Release/conpty.node'
        ? dlopenError(SHARING_VIOLATION)
        : notFound(path)
    })

    const message = loadError(loadNativeModule, 'conpty')

    expect(message).toBe(
      `Failed to load native module: conpty.node, checked: ${WIN_DIRS}: ` +
        `../build/Release/conpty.node (ERR_DLOPEN_FAILED): ${SHARING_VIOLATION}; ` +
        `../build/Release/conpty.node on retry (ERR_DLOPEN_FAILED): ${SHARING_VIOLATION}`
    )
    expect(classifyNodePtyLoaderMessage(message)).toEqual({
      reason: 'load_failed',
      detail: message
    })
    expect(waits).toEqual([200])
    // Eight candidates plus the single retry.
    expect(requested).toHaveLength(9)
  })

  it('keeps the first denial when the file is gone by the time of the retry', () => {
    let releaseAttempts = 0
    const { loadNativeModule } = loadPatchedUtilsWithRequire('win32', (path) => {
      if (path === '../build/Release/conpty.node' && ++releaseAttempts === 1) {
        throw dlopenError('Access is denied.')
      }
      throw notFound(path)
    })

    const message = loadError(loadNativeModule, 'conpty')

    expect(message).toBe(
      `Failed to load native module: conpty.node, checked: ${WIN_DIRS}: ` +
        '../build/Release/conpty.node (ERR_DLOPEN_FAILED): Access is denied.'
    )
    expect(classifyNodePtyLoaderMessage(message).reason).toBe('load_failed')
  })

  it('spends the retry wait once per module per process', () => {
    const { loadNativeModule, waits } = loadPatchedUtilsWithRequire('win32', (path) => {
      throw path === '../build/Release/conpty.node'
        ? dlopenError('Access is denied.')
        : notFound(path)
    })

    loadError(loadNativeModule, 'conpty')
    const second = loadError(loadNativeModule, 'conpty')

    expect(waits).toEqual([200])
    expect(second).not.toContain('on retry')
  })

  it('reports a denial outside Windows without retrying it', () => {
    const { loadNativeModule, requested, waits } = loadPatchedUtilsWithRequire('linux', (path) => {
      throw path === '../build/Release/pty.node' ? dlopenError('Access is denied.') : notFound(path)
    })

    expect(loadError(loadNativeModule, 'pty')).toContain(
      '../build/Release/pty.node (ERR_DLOPEN_FAILED): Access is denied.'
    )
    expect(waits).toEqual([])
    expect(requested).toHaveLength(8)
  })
})
