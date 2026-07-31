export const BOOTSTRAP_FATAL_EXIT_GUARD_KEY = '__ORCA_BOOTSTRAP_FATAL_EXIT_GUARD__'

type BootstrapFatalExitGlobal = typeof globalThis & {
  [BOOTSTRAP_FATAL_EXIT_GUARD_KEY]?: () => void
}

export function removeBootstrapFatalExitGuard(): void {
  const bootstrapGlobal = globalThis as BootstrapFatalExitGlobal
  const removeGuard = bootstrapGlobal[BOOTSTRAP_FATAL_EXIT_GUARD_KEY]
  delete bootstrapGlobal[BOOTSTRAP_FATAL_EXIT_GUARD_KEY]
  removeGuard?.()
}
