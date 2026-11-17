import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { classifyNodePtyLoaderMessage } from './node-pty-loader-diagnosis'

// Exercises the loader added by config/patches/node-pty@1.1.0.patch, not a copy of it.
const require = createRequire(import.meta.url)
const PATCHED_UTILS = join(dirname(require.resolve('node-pty/package.json')), 'lib', 'utils.js')

type PatchedUtils = {
  loadNativeModule: (name: string) => unknown
  formatNativeModuleLoadError: (
    name: string,
    dirs: string[],
    failures: { path: string; error: unknown }[],
    lastError: unknown
  ) => string
  isTransientNativeModuleLoadError: (error: unknown, platform: string) => boolean
}

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function loadPatchedUtilsCopy(nativeFiles: Record<string, string> = {}): PatchedUtils {
  const root = mkdtempSync(join(tmpdir(), 'orca-node-pty-load-'))
  tempDirs.push(root)
  mkdirSync(join(root, 'lib'))
  copyFileSync(PATCHED_UTILS, join(root, 'lib', 'utils.js'))
  for (const [relativePath, contents] of Object.entries(nativeFiles)) {
    mkdirSync(dirname(join(root, relativePath)), { recursive: true })
    writeFileSync(join(root, relativePath), contents)
  }
  return require(join(root, 'lib', 'utils.js'))
}

function loadError(utils: PatchedUtils, name: string): string {
  try {
    utils.loadNativeModule(name)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error(`expected ${name}.node to fail to load`)
}

function dlopenError(message: string): Error {
  return Object.assign(new Error(message), { code: 'ERR_DLOPEN_FAILED' })
}

describe('patched node-pty native module loader', () => {
  it('keeps the real load failure instead of the final missing prebuilds directory', () => {
    const utils = loadPatchedUtilsCopy({ 'build/Release/broken.node': 'not a native module' })

    const message = loadError(utils, 'broken')

    expect(message).toMatch(/^Failed to load native module: broken\.node, checked: /)
    expect(message).toContain('../build/Release/broken.node (ERR_DLOPEN_FAILED): ')
    expect(message).not.toContain('Cannot find module')
  })

  it('keeps the original message when every candidate is missing', () => {
    const message = loadError(loadPatchedUtilsCopy(), 'absent')

    expect(message).toContain('Error: Cannot find module')
    expect(classifyNodePtyLoaderMessage(message).reason).toBe('dependency_missing')
  })

  it('reports each Windows load failure with its path and code', () => {
    const utils = loadPatchedUtilsCopy()
    const message = utils.formatNativeModuleLoadError(
      'conpty',
      ['build/orca-napi-win32-x64', 'build/Release', 'build/Debug', 'prebuilds/win32-x64'],
      [
        {
          path: '../build/Release/conpty.node',
          error: dlopenError(
            'The process cannot access the file because it is being used by another process.\r\n'
          )
        },
        { path: './build/Release/conpty.node', error: dlopenError('Access is denied.') }
      ],
      new Error('Cannot find module ./prebuilds/win32-x64//conpty.node')
    )

    expect(message).toBe(
      'Failed to load native module: conpty.node, checked: build/orca-napi-win32-x64, build/Release, build/Debug, prebuilds/win32-x64: ' +
        '../build/Release/conpty.node (ERR_DLOPEN_FAILED): The process cannot access the file because it is being used by another process.; ' +
        './build/Release/conpty.node (ERR_DLOPEN_FAILED): Access is denied.'
    )
    expect(classifyNodePtyLoaderMessage(message)).toEqual({
      reason: 'load_failed',
      detail: message
    })
  })

  it('retries only Windows sharing, lock, and access failures', () => {
    const utils = loadPatchedUtilsCopy()
    const isTransient = utils.isTransientNativeModuleLoadError

    expect(
      isTransient(
        dlopenError(
          'The process cannot access the file because it is being used by another process.'
        ),
        'win32'
      )
    ).toBe(true)
    expect(
      isTransient(
        dlopenError(
          'The process cannot access the file because another process has locked a portion of the file.'
        ),
        'win32'
      )
    ).toBe(true)
    expect(isTransient(dlopenError('Access is denied.'), 'win32')).toBe(true)
    expect(isTransient(Object.assign(new Error('busy'), { code: 'EBUSY' }), 'win32')).toBe(true)
    expect(isTransient(dlopenError('%1 is not a valid Win32 application.'), 'win32')).toBe(false)
    expect(
      isTransient(Object.assign(new Error('missing'), { code: 'MODULE_NOT_FOUND' }), 'win32')
    ).toBe(false)
    expect(isTransient(dlopenError('Access is denied.'), 'linux')).toBe(false)
  })
})
