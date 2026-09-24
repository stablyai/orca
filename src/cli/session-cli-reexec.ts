/**
 * Hands a command to the CLI the session named, when a different Orca CLI was the one invoked.
 *
 * Orca puts the absolute launcher of its own CLI in `ORCA_CLI_COMMAND` for every local terminal and
 * structured session. An agent may still reach another install — a login shell reorders PATH behind
 * a global `orca`, a helper script hardcodes `orca`, a user types `/usr/local/bin/orca` — and that
 * CLI can be older than the session's identity or dial a different instance. So a current CLI that
 * is not the named launcher re-runs the command through it, once, and exits with its status. Which
 * binary answers stops depending on the agent following instructions.
 *
 * Identity comes from `ORCA_CLI_SELF`, which Orca's packaged launchers and bare-`orca` shims export
 * (the outermost one wins); this entry's own argv names the JS file, never a launcher. A dev launcher
 * exports none on purpose: it pins its own instance, so running one is a deliberate choice of
 * instance, often from another instance's terminal. `ORCA_CLI_REEXEC=1` bounds the handoff to one
 * hop and is also the escape hatch. Both variables are consumed here, so no child of the CLI — an
 * Orca app it starts, a terminal that app opens — inherits a stale identity or a disabled handoff.
 *
 * WSL and SSH never qualify: they carry a guest command name or `orca`, not a host path, and a
 * relative command is never resolved against the working directory.
 */

import { realpathSync } from 'node:fs'
import { constants as osConstants } from 'node:os'
import { posix, resolve, win32 } from 'node:path'

export const ORCA_CLI_SELF_ENV = 'ORCA_CLI_SELF'
export const ORCA_CLI_REEXEC_ENV = 'ORCA_CLI_REEXEC'

/** Set by the launcher that started this process; the next launcher sets them again itself. */
const LAUNCHER_OWNED_ENV = ['ELECTRON_RUN_AS_NODE', 'ORCA_WINDOWS_PACKAGED_CLI_LAUNCHER'] as const
/** Stashed by every launcher so Electron's node bootstrap never sees them; the next one re-stashes. */
const LAUNCHER_STASHED_ENV = [
  ['ORCA_NODE_OPTIONS', 'NODE_OPTIONS'],
  ['ORCA_NODE_REPL_EXTERNAL_MODULE', 'NODE_REPL_EXTERNAL_MODULE']
] as const

export type SessionCliReexec = {
  target: string
  argv: readonly string[]
  env: NodeJS.ProcessEnv
}

type ReexecOptions = {
  env?: NodeJS.ProcessEnv
  argv?: readonly string[]
  platform?: NodeJS.Platform
}

/** The CLI entry: hand off to the session's own CLI when this is a different one, else `run`. */
export async function runAsSessionCli(
  run: () => Promise<void>,
  options: ReexecOptions & { exit?: (code: number) => never } = {}
): Promise<void> {
  const reexec = takeSessionCliReexec(options)
  if (reexec) {
    await runSessionCliReexec(reexec, options.exit)
  }
  await run()
}

/**
 * Removes the launcher handoff variables from `env` and returns the re-exec this process owes, or
 * null when it is already the named CLI, cannot tell, or is itself the one hop.
 */
export function takeSessionCliReexec(options: ReexecOptions = {}): SessionCliReexec | null {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const self = env[ORCA_CLI_SELF_ENV]?.trim()
  const alreadyHandedOff = env[ORCA_CLI_REEXEC_ENV] === '1'
  delete env[ORCA_CLI_SELF_ENV]
  delete env[ORCA_CLI_REEXEC_ENV]
  if (alreadyHandedOff || !self) {
    return null
  }
  const named = env.ORCA_CLI_COMMAND?.trim()
  if (!named || !(platform === 'win32' ? win32 : posix).isAbsolute(named)) {
    return null
  }
  const target = tryRealpath(named)
  const current = tryRealpath(self)
  if (target === null || current === null || samePath(target, current, platform)) {
    return null
  }
  return {
    target: named,
    argv: [...(options.argv ?? process.argv.slice(2))],
    env: buildHandoffEnv(env)
  }
}

/** The environment the invoked launcher was given, plus the one-hop guard. */
function buildHandoffEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const handoff: NodeJS.ProcessEnv = { ...env }
  for (const key of LAUNCHER_OWNED_ENV) {
    delete handoff[key]
  }
  for (const [stash, original] of LAUNCHER_STASHED_ENV) {
    const value = handoff[stash]
    delete handoff[stash]
    if (value) {
      handoff[original] = value
    }
  }
  handoff[ORCA_CLI_REEXEC_ENV] = '1'
  return handoff
}

function tryRealpath(path: string): string | null {
  try {
    return realpathSync(resolve(path))
  } catch {
    return null
  }
}

function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/**
 * Runs the handoff and exits with its status. Returns only when the named CLI could not be started,
 * so the command still runs here — the behavior before the handoff existed — rather than failing.
 */
export async function runSessionCliReexec(
  reexec: SessionCliReexec,
  exit: (code: number) => never = process.exit
): Promise<void> {
  const { runProcessSync } = await import('../shared/child-process/run-process.js')
  let result: { code: number | null; signal: NodeJS.Signals | null }
  try {
    result = runProcessSync({
      program: reexec.target,
      args: reexec.argv,
      env: reexec.env,
      stdio: 'inherit',
      timeoutMs: null
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    process.stderr.write(
      `orca: could not run this session's CLI (${reexec.target}): ${reason}. Running this one.\n`
    )
    return
  }
  exit(result.code ?? (result.signal ? 128 + (osConstants.signals[result.signal] ?? 0) : 1))
}
