/**
 * Builds the `docker exec` argv used to run a shell/agent inside a devcontainer.
 *
 * Security note on env: secret values (API keys, tokens) must NOT appear in the
 * argv — process arguments are world-readable via `ps`. So this builder emits
 * `-e NAME` (no value); docker forwards each NAME from the *docker client's own
 * environment*, which the PTY provider sets on the spawned process. Values that
 * genuinely need a literal (rare, non-secret) can go through `literalEnv`.
 */

export type BuildDockerExecArgsParams = {
  /** Target container id or name. */
  containerId: string
  /** Shell to launch (absolute path or bare name resolvable in the container). */
  shell: string
  /** Working directory *inside the container* (already host→container translated). */
  containerCwd?: string | null
  /** Allocate an interactive TTY (`-i -t`). Default true. */
  interactive?: boolean
  /** Variable NAMES to forward from the docker client env via `-e NAME` (no value in argv). */
  forwardEnv?: readonly string[]
  /** Literal, non-secret env entries emitted as `-e NAME=VALUE`. */
  literalEnv?: Readonly<Record<string, string>>
}

/** Construct the argv (after the `docker` binary) for `docker exec`. */
export function buildDockerExecArgs(params: BuildDockerExecArgsParams): string[] {
  const { containerId, shell, containerCwd, forwardEnv = [], literalEnv = {} } = params
  const interactive = params.interactive ?? true

  const args = ['exec']
  if (interactive) {
    args.push('-i', '-t')
  }
  if (containerCwd) {
    args.push('-w', containerCwd)
  }
  // `-e NAME` forwards the value from the client env without exposing it in argv.
  for (const name of forwardEnv) {
    args.push('-e', name)
  }
  for (const [name, value] of Object.entries(literalEnv)) {
    args.push('-e', `${name}=${value}`)
  }
  // `--` would be ideal before the command, but `docker exec` treats the first
  // non-flag token as the container id, so options must end here naturally.
  args.push(containerId, shell)
  return args
}
