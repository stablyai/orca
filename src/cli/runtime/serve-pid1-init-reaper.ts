import { existsSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

const BASH_CANDIDATES = ['/bin/bash', '/usr/bin/bash']

/**
 * Runs as PID 1: bash's wait reaps every exited child, including orphans the kernel reparents to
 * it, which Node cannot do (#28147). PID 1 ignores untrapped signals, so each is forwarded.
 * The served command runs in a forked subshell, so it is never PID 1 itself.
 * Why the subshell: async commands in a non-interactive shell otherwise start with INT/QUIT ignored.
 */
export const SERVE_INIT_REAPER_SCRIPT = [
  '(trap - INT QUIT; exec "$@") 0<&0 &',
  'child=$!',
  'for sig in TERM INT HUP QUIT USR1 USR2; do trap "kill -$sig $child 2>/dev/null" "$sig"; done',
  // Why the final wait: a trap can interrupt one, and bash keeps the reaped child's own status.
  'while kill -0 "$child" 2>/dev/null; do wait "$child"; done',
  'wait "$child"'
].join('\n')

export type ServeInitReaperDeps = {
  platform: NodeJS.Platform
  pid: number
  env: NodeJS.ProcessEnv
  execPath: string
  execArgv: readonly string[]
  argv: readonly string[]
  exists: (path: string) => boolean
  execve: ((file: string, args: string[], env: NodeJS.ProcessEnv) => void) | null
  warn: (line: string) => void
}

export type ServeInitReaperOutcome = 'not-pid1' | 'reexec' | 'unavailable'

const NO_REAPER_WARNING =
  '[serve] Orca is PID 1 and cannot reap orphaned processes, so they stay zombies. Run it under an init (docker run --init, tini, or bash).'

const EVAL_FLAGS = new Set(['-e', '--eval', '-p', '--print'])

type ServedCommand = { args: string[]; env: NodeJS.ProcessEnv }

function isInside(parent: string, child: string): boolean {
  const inside = relative(resolve(parent), resolve(child))
  return inside !== '' && !inside.startsWith('..') && !isAbsolute(inside)
}

function servedCommand(deps: ServeInitReaperDeps): ServedCommand | null {
  const evaluated = deps.execArgv.some((flag) => EVAL_FLAGS.has(flag))
  // Why: argv[1] is the CLI entry, except under `-e <cli> -- serve` (the legacy AppImage wrapper).
  const cliArgs = deps.argv.slice(evaluated ? 1 : 2)
  const appDir = deps.env.APPDIR
  if (appDir && isAbsolute(appDir) && isInside(appDir, deps.execPath)) {
    // Why: the exec would release this AppImage's mount under bash, so run the image afresh instead.
    const image = deps.env.APPIMAGE
    if (!image || !isAbsolute(image) || !deps.exists(image)) {
      return null
    }
    const env = { ...deps.env }
    delete env.ELECTRON_RUN_AS_NODE
    // Why: the image's own CLI redirect moves these aside again; restore what the user set.
    for (const name of ['NODE_OPTIONS', 'NODE_REPL_EXTERNAL_MODULE']) {
      const saved = env[`ORCA_${name}`]
      delete env[`ORCA_${name}`]
      if (saved) {
        env[name] = saved
      }
    }
    return { args: [image, ...cliArgs], env }
  }
  const entry = evaluated ? ['--'] : [deps.argv[1] ?? '']
  return { args: [deps.execPath, ...deps.execArgv, ...entry, ...cliArgs], env: deps.env }
}

/** Replaces a PID 1 Linux serve with bash supervising the same command; returns only when it did not. */
export function reexecServeUnderInitReaper(deps: ServeInitReaperDeps): ServeInitReaperOutcome {
  if (deps.platform !== 'linux' || deps.pid !== 1) {
    return 'not-pid1'
  }
  const bash = BASH_CANDIDATES.find((candidate) => deps.exists(candidate))
  const command = servedCommand(deps)
  if (!bash || !deps.execve || !command) {
    deps.warn(NO_REAPER_WARNING)
    return 'unavailable'
  }
  try {
    deps.execve(
      bash,
      ['bash', '-c', SERVE_INIT_REAPER_SCRIPT, 'orca-serve-init', ...command.args],
      command.env
    )
  } catch (error) {
    deps.warn(`${NO_REAPER_WARNING} (${error instanceof Error ? error.message : String(error)})`)
    return 'unavailable'
  }
  return 'reexec'
}

export function reexecThisServeUnderInitReaper(): ServeInitReaperOutcome {
  const execve = process.execve
  return reexecServeUnderInitReaper({
    platform: process.platform,
    pid: process.pid,
    env: process.env,
    execPath: process.execPath,
    execArgv: process.execArgv,
    argv: process.argv,
    exists: existsSync,
    execve: execve ? (file, args, env) => execve.call(process, file, args, env) : null,
    warn: (line) => process.stderr.write(`${line}\n`)
  })
}
