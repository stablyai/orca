import { access, constants as fsConstants } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export type OmpExecutableResolverDeps = {
  isCommandOnPath: (command: string) => Promise<boolean>
  resolveCommandOnPath?: (command: string) => Promise<string | null>
  /** Merges the login shell's PATH into process.env; resolves even on failure. */
  hydrateShellPath: () => Promise<void>
  /** Re-probes the shell, bypassing the process-wide hydration cache. */
  rehydrateShellPathForced: () => Promise<void>
  homedir?: () => string
  platform?: NodeJS.Platform
  canExecute?: (candidate: string) => Promise<boolean>
}

async function defaultCanExecute(candidate: string): Promise<boolean> {
  try {
    await access(candidate, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Installer locations probed only after every PATH strategy failed. Absolute
 *  and user-local, so a hit is the same binary a terminal would run. */
function wellKnownPosixLocations(command: string, home: string): string[] {
  return [
    path.join(home, '.local', 'bin', command),
    path.join(home, '.bun', 'bin', command),
    `/opt/homebrew/bin/${command}`,
    `/usr/local/bin/${command}`
  ]
}

/**
 * Resolve the OMP launch command to something spawnable, in fidelity order:
 * bare PATH lookup (matches the TUI exactly), login-shell PATH hydration,
 * one forced re-hydration (the process-wide hydration cache retains cold-start
 * timeouts forever), then well-known installer paths as a last resort.
 */
export function createOmpExecutableResolver(deps: OmpExecutableResolverDeps) {
  const canExecute = deps.canExecute ?? defaultCanExecute
  let hydrated: Promise<void> | null = null
  let rehydratedForced: Promise<void> | null = null

  return async function resolveOmpExecutable(command: string): Promise<string | null> {
    const resolveOnPath = async (): Promise<string | null> => {
      const resolved = await deps.resolveCommandOnPath?.(command)
      if (resolved) {
        return resolved
      }
      return (await deps.isCommandOnPath(command)) ? command : null
    }
    const initial = await resolveOnPath()
    if (initial) {
      return initial
    }
    hydrated ??= deps.hydrateShellPath()
    await hydrated
    const hydratedPath = await resolveOnPath()
    if (hydratedPath) {
      return hydratedPath
    }
    rehydratedForced ??= deps.rehydrateShellPathForced()
    await rehydratedForced
    const forcedPath = await resolveOnPath()
    if (forcedPath) {
      return forcedPath
    }
    if ((deps.platform ?? process.platform) === 'win32') {
      return null
    }
    for (const candidate of wellKnownPosixLocations(command, (deps.homedir ?? os.homedir)())) {
      if (await canExecute(candidate)) {
        return candidate
      }
    }
    return null
  }
}
