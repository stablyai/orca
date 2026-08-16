/**
 * Opt-in 1Password secret resolution for local PTY startup commands.
 *
 * When the spawn env carries `op://` secret references, the startup command is
 * wrapped in `op run -- …` so the 1Password CLI resolves them inside the PTY —
 * Orca never executes `op` itself and never sees secret values. Running `op`
 * from the main process would also bypass the macOS TCC login-shell attribution
 * fix (#6996/#8985) and revive its permission-prompt storm.
 */

export const OP_SECRET_REFERENCE_PREFIX = 'op://'

// Why: chained/multiline commands must stay inside `op run`'s env — `op run -- a && b` would run `b` unresolved.
const SHELL_METACHAR_RE = /[|&;<>()`$\r\n]/

// Why: `FOO=bar cmd` (and bash's `FOO+=bar cmd`) is shell assignment syntax, not an argv —
// `op run -- FOO=bar cmd` would exec "FOO=bar".
const LEADING_ENV_ASSIGNMENT_RE = /^\s*[A-Za-z_][A-Za-z0-9_]*\+?=/

function needsShellWrapping(command: string): boolean {
  return SHELL_METACHAR_RE.test(command) || LEADING_ENV_ASSIGNMENT_RE.test(command)
}

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
  if (needsShellWrapping(command)) {
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
  opts: {
    enabled: boolean
    connectionId: string | null | undefined
    daemonHostSpawn?: boolean
    platform?: NodeJS.Platform
  }
): string | undefined {
  if (
    !opts.enabled ||
    opts.connectionId || // op is a local-machine assumption; never rewrite remote spawns
    opts.daemonHostSpawn || // runtime-owned tabs resolve against the runtime's account, not the user's — keep refs literal
    command === undefined ||
    command.trim().length === 0 ||
    !hasOpSecretReferences(env)
  ) {
    return command
  }
  return wrapStartupCommandWithOpRun(command, opts.platform ?? process.platform)
}
