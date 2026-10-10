import { join } from 'node:path'
import { app } from 'electron'

export type NativeCodeCacheResult = {
  enabled: boolean
  directory: string | null
  error?: string
}

// Why: the main-process graph itself is cached by the build-time compile-cache banner
// prepended to out/main/index.js (see electron.vite.config.ts) — this runtime call is
// only the idempotent fallback for entry paths that skip the banner. It pins the
// resolved cache dir into NODE_COMPILE_CACHE so forked children reuse the same cache.
export function enableMainProcessCompileCache(customCacheDir?: string): NativeCodeCacheResult {
  try {
    const nodeModule = require('node:module') as {
      enableCompileCache?: (dir?: string) => { status: number; directory: string }
    }

    if (typeof nodeModule.enableCompileCache !== 'function') {
      return { enabled: false, directory: null }
    }

    const cacheDir =
      customCacheDir ??
      process.env.NODE_COMPILE_CACHE ??
      (typeof app?.getPath === 'function'
        ? join(app.getPath('userData'), 'compile-cache')
        : undefined)

    const result = nodeModule.enableCompileCache(cacheDir)
    if (result && result.directory) {
      // Why: child processes (daemon, plugin-host, watcher) inherit env and automatically use compile cache.
      process.env.NODE_COMPILE_CACHE = result.directory
      return { enabled: true, directory: result.directory }
    }

    return { enabled: false, directory: null }
  } catch (error) {
    return {
      enabled: false,
      directory: null,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
