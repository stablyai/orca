import {
  assertWslAccountExecutionTarget,
  type WslAccountExecutionContext
} from '../wsl/wsl-account-execution-context'
import type { LegacyWslRuntimeAuthDestination } from './legacy-wsl-runtime-auth-drain'

export type LegacyWslRuntimeAuthDrainOptions = {
  execution?: WslAccountExecutionContext
  distro: string
  guestHomeLinuxPath: string
  legacyPanePresent: boolean
  resolveDestination: (
    runtimeAuthContents: string
  ) => LegacyWslRuntimeAuthDestination | null | Promise<LegacyWslRuntimeAuthDestination | null>
}

export function captureDrainOptions(
  options: LegacyWslRuntimeAuthDrainOptions
): LegacyWslRuntimeAuthDrainOptions {
  if (!options.execution) {
    return options
  }
  const execution = Object.freeze({ ...options.execution })
  assertWslAccountExecutionTarget(execution, { runtime: 'wsl', wslDistro: options.distro })
  if (options.guestHomeLinuxPath !== execution.home) {
    throw new Error('WSL drain home does not match captured owner')
  }
  return { ...options, execution }
}

export function drainOwnerKey(options: LegacyWslRuntimeAuthDrainOptions): string {
  return options.execution
    ? JSON.stringify([
        options.distro.toLowerCase(),
        options.execution.userName,
        options.execution.userId,
        options.execution.home
      ])
    : options.distro.trim().toLowerCase()
}
