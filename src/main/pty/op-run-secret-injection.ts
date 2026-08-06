/**
 * Opt-in 1Password secret resolution for local PTY startup commands.
 *
 * When the spawn env carries `op://` secret references, the startup command is
 * wrapped in `op run -- …` so the 1Password CLI resolves them inside the PTY —
 * Orca never executes `op` itself and never sees secret values. Running `op`
 * from the main process would also bypass the macOS TCC login-shell attribution
 * fix (#6996/#8985) and revive its permission-prompt storm.
 */

const OP_SECRET_REFERENCE_PREFIX = 'op://'

// Why: chained commands must stay inside `op run`'s env — `op run -- a && b` would run `b` unresolved.
const SHELL_METACHAR_RE = /[|&;<>()`$]/

export function hasOpSecretReferences(env: Record<string, string> | undefined): boolean {
  if (!env) {
    return false
  }
  return Object.values(env).some((value) => value.startsWith(OP_SECRET_REFERENCE_PREFIX))
}

function singleQuoteForPosixShell(command: string): string {
  return `'${command.replaceAll("'", "'\\''")}'`
}

export function wrapStartupCommandWithOpRun(
  command: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (SHELL_METACHAR_RE.test(command)) {
    // Why: no portable single-line quoting for cmd/powershell — leave chained commands untouched on Windows (documented limitation).
    if (platform === 'win32') {
      return command
    }
    return `op run -- sh -c ${singleQuoteForPosixShell(command)}`
  }
  return `op run -- ${command}`
}

export function maybeWrapStartupCommandWithOpRun(
  command: string | undefined,
  env: Record<string, string> | undefined,
  opts: { enabled: boolean; connectionId: string | null | undefined; platform?: NodeJS.Platform }
): string | undefined {
  if (
    !opts.enabled ||
    opts.connectionId || // op is a local-machine assumption; never rewrite remote spawns
    command === undefined ||
    command.trim().length === 0 ||
    !hasOpSecretReferences(env)
  ) {
    return command
  }
  return wrapStartupCommandWithOpRun(command, opts.platform ?? process.platform)
}
