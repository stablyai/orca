import { exec } from 'node:child_process'

/** How long a hook gets to die politely once its deadline passes, before SIGKILL. */
const SIGTERM_GRACE_MS = 2_000

export type HookScriptResult = {
  success: boolean
  output: string
  /** Omitted whenever no exit was observed, which the removal gate reads as `unverifiable`. */
  exitCode?: number
}

/** Signal the hook's whole process group where the platform has one, else just the child. */
function terminate(
  child: { pid?: number; kill: (signal: NodeJS.Signals) => boolean },
  signal: NodeJS.Signals
): void {
  // Why the group: the script is a shell, and the real work is its children. Signalling only the
  // shell leaves `sleep`/`rsync` grandchildren alive, still holding the output pipes open.
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // Group already gone, or we never became its leader; fall through to the direct kill.
    }
  }
  try {
    child.kill(signal)
  } catch {
    // Already dead.
  }
}

/**
 * Run a hook script under a deadline we own.
 *
 * Why not Node's own `exec({ timeout })` (#19334): it SIGTERMs the child and then reports whatever
 * the child chose to do. A hook that traps SIGTERM and exits 0 — a graceful `process.on('SIGTERM')`
 * in a Node wrapper, an rsync wrapper cleaning up — comes back with a NULL error, so a hook cut
 * short mid-archive is indistinguishable from one that finished its work.
 *
 * Two rules follow. The verdict comes from the deadline rather than the corpse's exit code, and it
 * is settled *at* the deadline rather than whenever the child gets around to dying — a hook that
 * traps the signal and keeps running must not hold a removal open. Termination still escalates
 * SIGTERM then SIGKILL afterwards, so a well-behaved hook gets its chance to clean up.
 *
 * On timeout the exit code is withheld: whatever the child did after the signal, we never observed
 * it finish its work.
 */
export function runHookScriptWithDeadline(args: {
  script: string
  cwd: string
  /** Undefined lets Node pick the platform default, matching the incumbent behaviour. */
  shell: string | undefined
  env: NodeJS.ProcessEnv
  timeoutMs: number
}): Promise<HookScriptResult> {
  return new Promise((resolve) => {
    let settled = false
    let deadline: NodeJS.Timeout | undefined
    const settle = (result: HookScriptResult): void => {
      if (settled) {
        return
      }
      settled = true
      if (deadline) {
        clearTimeout(deadline)
      }
      resolve(result)
    }

    const child = exec(
      args.script,
      {
        cwd: args.cwd,
        ...(args.shell ? { shell: args.shell } : {}),
        env: args.env,
        // Become a process-group leader so the deadline can reach the whole tree.
        ...(process.platform === 'win32' ? {} : { detached: true })
      },
      (error, stdout, stderr) => {
        if (error) {
          // A string `code` (ENOENT and friends) means the process never started, so no exit was
          // observed — the numeric check is what keeps that out of the `exited` verdict.
          const code = (error as { code?: unknown }).code
          settle({
            success: false,
            output: `${stdout}\n${stderr}\n${error.message}`.trim(),
            ...(typeof code === 'number' ? { exitCode: code } : {})
          })
          return
        }
        settle({ success: true, output: `${stdout}\n${stderr}`.trim(), exitCode: 0 })
      }
    )

    deadline = setTimeout(() => {
      settle({ success: false, output: `Hook timed out after ${args.timeoutMs}ms.` })
      terminate(child, 'SIGTERM')
      setTimeout(() => terminate(child, 'SIGKILL'), SIGTERM_GRACE_MS).unref?.()
    }, args.timeoutMs)
  })
}
