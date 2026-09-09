import { afterEach, describe, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  OVERLAY_ONLY_FEATURES,
  STARTUP_COMMAND_FEATURES
} from '../shell-startup-launch-intent-fixtures'

// Why: can't import electron (bundled into the plain-node daemon-entry fork), so tests set the wrapper root via ORCA_USER_DATA_PATH instead of mocking app.
export function setTestUserDataPath(path: string): void {
  process.env.ORCA_USER_DATA_PATH = path
}

export function restoreUserDataPathAfterEach(): void {
  const original = process.env.ORCA_USER_DATA_PATH
  afterEach(() => {
    if (original === undefined) {
      delete process.env.ORCA_USER_DATA_PATH
    } else {
      process.env.ORCA_USER_DATA_PATH = original
    }
  })
}

export async function importFreshLocalPtyShellReady() {
  vi.resetModules()
  const module = await import('./local-pty-shell-ready')
  // Why the two adapters: the module exposes one feature-driven entry point, and
  // these are the two launch intents the call sites select between.
  return {
    ...module,
    getShellReadyLaunchConfig: (shell: string) =>
      module.getShellLaunchConfig(shell, STARTUP_COMMAND_FEATURES),
    getMarkerlessShellLaunchConfig: (shell: string) =>
      module.getShellLaunchConfig(shell, OVERLAY_ONLY_FEATURES)
  }
}

/** Plain suite call only; annotated because the inferred `describe.skip` type names vitest-runner internals. */
export type ConditionalDescribe = (name: string, factory: () => void) => void

export const describePosix: ConditionalDescribe =
  process.platform === 'win32' ? describe.skip : describe

const hasZsh = (() => {
  const result = spawnSync('which', ['zsh'], { encoding: 'utf8' })
  return result.status === 0
})()

export const describeIfZsh: ConditionalDescribe = hasZsh ? describe : describe.skip
