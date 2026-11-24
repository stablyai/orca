export type TerminalSpawnAdmissionMode = 'observe' | 'enforce'

export const TERMINAL_SPAWN_ADMISSION_ARG = '--spawn-admission'

// Rollback switch: `observe` makes newly launched daemons count decisions without pacing.
export const TERMINAL_SPAWN_ADMISSION_ENV_VAR = 'ORCA_TERMINAL_SPAWN_ADMISSION'

/** The mode a launcher passes its daemon: enforce, unless the env var asks for `observe`. */
export function resolveTerminalSpawnAdmissionMode(
  env: NodeJS.ProcessEnv = process.env
): TerminalSpawnAdmissionMode {
  return env[TERMINAL_SPAWN_ADMISSION_ENV_VAR]?.trim().toLowerCase() === 'observe'
    ? 'observe'
    : 'enforce'
}

/** Reads the launcher's `--spawn-admission <mode>`; anything else observes. */
export function readTerminalSpawnAdmissionArg(argv: readonly string[]): TerminalSpawnAdmissionMode {
  const index = argv.indexOf(TERMINAL_SPAWN_ADMISSION_ARG)
  return index !== -1 && argv[index + 1] === 'enforce' ? 'enforce' : 'observe'
}
