import { existsSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

const BASH_CANDIDATES = ['/bin/bash', '/usr/bin/bash']

/** Bash reaps PID 1’s orphans; a subshell restores INT/QUIT, and traps forward PID 1’s signals (#28147). */
export const SERVE_INIT_REAPER_SCRIPT = [
  '(trap - INT QUIT; exec "$@") 0<&0 &',
  'child=$!',
  'for sig in TERM INT HUP QUIT USR1 USR2; do trap "kill -$sig $child 2>/dev/null" "$sig"; done',
  // Traps can interrupt wait; the final wait retains the reaped child’s status.
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
  // Legacy AppImage wrappers evaluate the CLI with -e, shifting its argv offset.
  const cliArgs = deps.argv.slice(evaluated ? 1 : 2)
  const appDir = deps.env.APPDIR
  if (appDir && isAbsolute(appDir) && isInside(appDir, deps.execPath)) {
    // Re-execing into bash releases the current AppImage mount; start the image afresh.
    const image = deps.env.APPIMAGE
    if (!image || !isAbsolute(image) || !deps.exists(image)) {
      return null
    }
    const env = { ...deps.env }
    delete env.ELECTRON_RUN_AS_NODE
    // Restore user options before the AppImage launcher moves them aside again.
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

/** Replace Linux PID 1 serve with a Bash reaper; return only if no replacement occurred. */
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
