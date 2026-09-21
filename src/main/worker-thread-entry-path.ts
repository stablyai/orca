import { join } from 'node:path'
import { getAppEnvironment, hasAppEnvironment } from '../shared/app-environment'

/**
 * Where a built worker-thread entry lives at runtime. Packaged builds leave
 * these entries inside app.asar — only forked child processes are asarUnpack'd —
 * so they resolve off resourcesPath rather than the bundler's `__dirname`.
 *
 * This module must not contain the literal text require('electron'): it is
 * reachable from worker clients that plain-Node fork entries also import, and
 * the build's plain-node-entry-guard rejects that text even inside a try/catch.
 */
export type WorkerEntryLayout = {
  isPackaged: boolean
  /** Undefined on a non-Electron host: `process.resourcesPath` is Electron-only. */
  resourcesPath: string | undefined
  moduleDir: string
}

/**
 * Resolve a built worker entry for one runtime layout.
 * @param layout - Packaged flag plus both candidate roots.
 * @param entryFileName - Built file name, e.g. `usage-scan-worker-entry.js`.
 * @returns Path passed to `new Worker()`.
 */
export function resolveWorkerThreadEntryPath(
  layout: WorkerEntryLayout,
  entryFileName: string
): string {
  // Why the resourcesPath guard: `isPackaged` is true on orcad too, but
  // `process.resourcesPath` is Electron-only and undefined under plain Node —
  // joining it threw a TypeError rather than failing as a missing worker. A host
  // without an Electron resources tree has no asar to look in, so fall back to
  // the module dir and let the caller report a missing worker honestly.
  if (layout.isPackaged && layout.resourcesPath) {
    return join(layout.resourcesPath, 'app.asar', 'out', 'main', entryFileName)
  }
  return join(layout.moduleDir, entryFileName)
}

/**
 * The current process's worker-entry layout.
 * @param moduleDir - The calling module's `__dirname`, used for unpackaged builds.
 * @returns Layout for `resolveWorkerThreadEntryPath`.
 */
export function currentWorkerEntryLayout(moduleDir: string): WorkerEntryLayout {
  return {
    isPackaged: hasAppEnvironment() && getAppEnvironment().isPackaged(),
    resourcesPath: process.resourcesPath,
    moduleDir
  }
}
