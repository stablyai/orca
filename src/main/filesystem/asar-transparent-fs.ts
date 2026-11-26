// Electron's fs treats a *.asar as a directory and, on Windows, keeps it open (EBUSY) until exit.
// Avoid process.noAsar: other main-process work may load app.asar during a long removal.

import * as nodeFs from 'node:fs'
import * as patchedFsPromises from 'node:fs/promises'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'

type NativeFs = {
  promises: typeof nodeFs.promises
  // Why callbacks: Electron's own fs.promises stat/lstat/realpath promisify these callbacks.
  stat: (path: string) => Promise<nodeFs.Stats>
  lstat: (path: string) => Promise<nodeFs.Stats>
  realpath: (path: string) => Promise<string>
}

let resolved: NativeFs | undefined

function loadOriginalFs(): typeof nodeFs {
  try {
    // Resolve lazily: original-fs exists only in Electron; plain Node's fs is already unpatched.
    return createRequire(__filename)('original-fs')
  } catch {
    return nodeFs
  }
}

function nativeFs(): NativeFs {
  if (!resolved) {
    const fs = loadOriginalFs()
    resolved = {
      promises: fs.promises,
      stat: promisify(fs.stat),
      lstat: promisify(fs.lstat),
      realpath: promisify(fs.realpath.native)
    }
  }
  return resolved
}

/** `fs.promises.rm` that sees a `*.asar` as the file it is rather than as a directory. */
export const rm: typeof nodeFs.promises.rm = (path, options) =>
  nativeFs().promises.rm(path, options)
export const readdir = (path: string): Promise<string[]> => nativeFs().promises.readdir(path)
export const unlink = (path: string): Promise<void> => nativeFs().promises.unlink(path)
export const rmdir = (path: string): Promise<void> => nativeFs().promises.rmdir(path)
export const lstat = (path: string): Promise<nodeFs.Stats> => nativeFs().lstat(path)
export const lstatBigInt = (path: string) => nativeFs().promises.lstat(path, { bigint: true })
export const readUtf8File = (path: string): Promise<string> =>
  nativeFs().promises.readFile(path, 'utf8')

type PathProbeFs = Pick<NativeFs, 'stat' | 'lstat' | 'realpath'>

// Why win32 only: the archive lock is the bug there; elsewhere patched fs keeps paths inside an
// archive (stack traces into app.asar) resolvable.
function pathProbeFs(): PathProbeFs {
  return process.platform === 'win32' ? nativeFs() : patchedFsPromises
}

export const statWithoutArchiveLock = (path: string): Promise<nodeFs.Stats> =>
  pathProbeFs().stat(path)
export const lstatWithoutArchiveLock = (path: string): Promise<nodeFs.Stats> =>
  pathProbeFs().lstat(path)
export const realpathWithoutArchiveLock = (path: string): Promise<string> =>
  pathProbeFs().realpath(path)
