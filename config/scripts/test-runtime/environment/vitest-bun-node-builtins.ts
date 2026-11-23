import fs from 'node:fs'
import os from 'node:os'
import { vi } from 'vitest'

declare global {
  var orcaBunNodeBuiltinsNormalized: boolean | undefined
}

// Bun on Windows deletes the cwd for a recursive rm('') (oven-sh/bun#47420). Node fails
// with ENOENT, which rm's `force` suppresses; Bun matches that once the call is not recursive.
// Bun-native named ESM exports (e.g. vi.mock importOriginal spreads) keep the unguarded function.
function stopRecursiveRemovalOfEmptyPath(api: typeof fs | typeof fs.promises, name: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(api, name)
  const remove: unknown = descriptor?.value
  if (!descriptor || typeof remove !== 'function') {
    return
  }
  const target = remove
  function guarded(this: unknown, ...args: unknown[]): unknown {
    const [path, options] = args
    if (path === '' && typeof options === 'object' && options !== null) {
      args[1] = { ...options, recursive: false }
    }
    return target.apply(this, args)
  }
  Object.defineProperty(api, name, { ...descriptor, value: guarded })
}

if (process.versions.bun) {
  if (!globalThis.orcaBunNodeBuiltinsNormalized) {
    const access = fs.promises.access
    // Bun resolves access() with null; Node's Promise<void> resolves with undefined.
    fs.promises.access = async (...args) => {
      await access(...args)
    }
    stopRecursiveRemovalOfEmptyPath(fs, 'rm')
    stopRecursiveRemovalOfEmptyPath(fs, 'rmSync')
    stopRecursiveRemovalOfEmptyPath(fs.promises, 'rm')
    globalThis.orcaBunNodeBuiltinsNormalized = true
  }

  // Child fixtures exercise the application's Node runtime, independently of Vitest's runtime.
  const nodeExecutable = process.env.ORCA_TEST_NODE_EXECUTABLE ?? process.env.npm_node_execpath
  if (nodeExecutable) {
    process.execPath = nodeExecutable
  }

  // Bun caches HOME and does not publish the write guard through syncBuiltinESMExports.
  const homedir = () =>
    (process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME) ?? os.homedir()

  vi.doMock('node:os', () => ({ ...os, homedir, default: { ...os, homedir } }))
  vi.doMock('node:fs', () => ({ ...fs, default: fs }))
  vi.doMock('node:fs/promises', () => ({ ...fs.promises, default: fs.promises }))
}
