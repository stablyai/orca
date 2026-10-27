// Electron treats .asar files as directories; unpatched fs prevents recursive rm failures.
// Avoid process.noAsar: other main-process work may load app.asar during a long removal.

import * as nodeFs from 'node:fs/promises'
import { createRequire } from 'node:module'

let resolvedFs: typeof nodeFs | undefined

function nativeFs(): typeof nodeFs {
  if (!resolvedFs) {
    try {
      // Resolve lazily: original-fs exists only in Electron; plain Node's fs is already unpatched.
      const originalFs: { promises?: typeof nodeFs } = createRequire(__filename)('original-fs')
      resolvedFs = originalFs.promises ?? nodeFs
    } catch {
      resolvedFs = nodeFs
    }
  }
  return resolvedFs
}

/** `fs.promises.rm` that sees a `*.asar` as the file it is rather than as a directory. */
export const rm: typeof nodeFs.rm = (path, options) => nativeFs().rm(path, options)
export const readdir = (path: string): Promise<string[]> => nativeFs().readdir(path)
export const unlink = (path: string): Promise<void> => nativeFs().unlink(path)
export const rmdir = (path: string): Promise<void> => nativeFs().rmdir(path)
export const lstat = (path: string) => nativeFs().lstat(path)
