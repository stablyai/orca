import { readFileSync } from 'node:fs'
import { getMainE2EConfig } from '../e2e-config'

/** Correction — a disposable profile must take its daemon and every supervised
 *  descendant down with it.
 *
 *  What happened: candidate runtimes were launched with `ORCA_DEV_USER_DATA_PATH`
 *  pointed at a throwaway state root. Quitting the candidate app ran the warm
 *  path — `disconnectDaemon()` — which deliberately LEAVES the daemon running so
 *  sessions stay warm for reattach. The state root was then deleted. Nineteen
 *  daemons and twenty-five supervised agent sessions outlived their runtimes,
 *  their databases and their sockets, and kept writing to a shared checkout for
 *  hours. Warm reattach is meaningless for a profile that will not exist.
 *
 *  So the rule is a property of the PROFILE, not of how the app was asked to
 *  quit: a state root that is disposable owns its daemon.
 */

/** True when this runtime is running out of a throwaway state root. Both cases
 *  are ones where nothing can ever reattach: a dev/candidate override profile,
 *  and an E2E per-spec profile. */
export function runsOnDisposableProfile(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.ORCA_DEV_USER_DATA_PATH) {
    return true
  }
  try {
    return Boolean(getMainE2EConfig().userDataDir)
  } catch {
    return false
  }
}

/** Which daemon teardown a quit must take.
 *
 *  `disconnect` is the warm path: the daemon survives so the user's terminals
 *  are still there next launch. `shutdown` kills the daemon and every session it
 *  supervises. A disposable profile must always take `shutdown` — there is
 *  nothing for a surviving daemon to be reattached to, and leaving one up is
 *  what orphaned nineteen of them. */
export function chooseDaemonTeardown(args: {
  devParentShutdownRequested: boolean
  disposableProfile: boolean
}): 'shutdown' | 'disconnect' {
  return args.devParentShutdownRequested || args.disposableProfile ? 'shutdown' : 'disconnect'
}

/** The SSH boundary vocabulary, because this is the same question: loss of
 *  contact with a process is never evidence it died.
 *  See docs/reference/ssh-execution-boundary.md. */
export type DescendantExitVerdict = 'exited' | 'live' | 'unverifiable'

export type DaemonExitProof = {
  verdict: DescendantExitVerdict
  pid: number | null
  reason: string
}

function readRecordedDaemonPid(pidRecordPath: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(pidRecordPath, 'utf8')) as { pid?: unknown }
    return typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 1
      ? parsed.pid
      : null
  } catch {
    return null
  }
}

/** Proves — or refuses to claim — that the daemon this profile owned is gone.
 *
 *  Signal 0 asks the kernel whether the pid exists without touching it. ESRCH is
 *  the only answer that proves exit; EPERM means it exists under another user,
 *  which is emphatically not exit; anything else is unverifiable. State deletion
 *  is only safe on `exited`. */
export function proveDaemonExited(
  pidRecordPath: string,
  probe: (pid: number) => void = (pid) => process.kill(pid, 0)
): DaemonExitProof {
  const pid = readRecordedDaemonPid(pidRecordPath)
  if (pid === null) {
    return {
      verdict: 'unverifiable',
      pid: null,
      reason: `No daemon pid record at ${pidRecordPath}, so nothing identifies the process that must have exited.`
    }
  }
  try {
    probe(pid)
    return { verdict: 'live', pid, reason: `Daemon pid ${pid} is still running.` }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code === 'ESRCH') {
      return { verdict: 'exited', pid, reason: `Daemon pid ${pid} no longer exists.` }
    }
    if (code === 'EPERM') {
      return {
        verdict: 'live',
        pid,
        reason: `Daemon pid ${pid} exists but is owned by another user.`
      }
    }
    return {
      verdict: 'unverifiable',
      pid,
      reason: `Could not establish whether daemon pid ${pid} exited (${code ?? 'unknown error'}).`
    }
  }
}

/** True only when the profile's own processes are proven gone. Deleting a state
 *  root on anything else is what left writers alive with no database, no socket
 *  and no way to be found again. */
export function stateDeletionIsSafe(proof: DaemonExitProof): boolean {
  return proof.verdict === 'exited'
}
