/**
 * What `orcad --print-service` can see about this host that the generated file cannot say
 * for itself.
 *
 * All warnings rather than refusals: a definition is often generated on one host to be
 * installed on another, so an unusable local scope is not proof the file is wrong.
 */
import { accessSync, constants, existsSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { runProcess } from '../../shared/child-process/run-process'
import {
  checkDaemonSocketPathBudget,
  DAEMON_SOCKET_PATH_REMEDY,
  describeDaemonSocketPathOverflow
} from '../daemon/daemon-runtime-paths'

/**
 * Version-scoped interpreter prefixes: a `brew upgrade node`, `nvm install`, or `mise use`
 * removes the directory the pinned path names, and the unit then dies 203/EXEC long after
 * the change that caused it.
 */
// The `\.?` matters: these tools install to a dotted directory (`.nvm`, `.asdf`) in a home
// directory but an undotted one under a shared prefix, and only one of those spellings
// would otherwise match.
const VERSION_SCOPED_INTERPRETER =
  /\/Cellar\/|\/\.?nvm\/versions\/|\/\.?mise\/installs\/|\/\.?asdf\/installs\/|\/\.?volta\/tools\/image\//

/**
 * Why warn and not silently rewrite: "the service runs the node that generated it" is the
 * contract, and guessing which stable symlink an operator meant is how a service ends up
 * on an interpreter nobody chose.
 */
export function versionScopedInterpreterWarning(nodePath: string): string | null {
  if (!VERSION_SCOPED_INTERPRETER.test(nodePath)) {
    return null
  }
  return (
    `Warning: ExecStart pins ${nodePath}, which is a version-scoped path. ` +
    'Upgrading that package manager removes the directory and the service then fails ' +
    '203/EXEC. Pass --node with a stable path (the manager’s current-version symlink) ' +
    'if you want the service to survive an interpreter upgrade.'
  )
}

/**
 * Why this exists at all: the version-scoped warning above tells operators to pass
 * `--node`, and `--node` was the one interpreter source with no validation. The default
 * cannot have the problem — `process.execPath` is tautologically on disk — so the gap bit
 * only the people who did what the warning told them to.
 *
 * A warning rather than a refusal, on the same ground as the user-scope warning: generating
 * on one host to install on another is legitimate, and the path may exist only there.
 */
export function interpreterOnDiskWarning(nodePath: string, wasChosen: boolean): string | null {
  if (!wasChosen) {
    return null
  }
  if (!existsSync(nodePath)) {
    return (
      `Warning: --node ${nodePath} does not exist on this host, so the service would fail ` +
      '203/EXEC if installed here. Intentional when you are generating for another host; ' +
      'otherwise check the path.'
    )
  }
  try {
    accessSync(nodePath, constants.X_OK)
  } catch {
    return (
      `Warning: --node ${nodePath} exists but is not executable, so the service would fail ` +
      '203/EXEC. Point --node at the interpreter binary itself.'
    )
  }
  return null
}

/**
 * The doctor calls an over-budget data root `critical` — the daemon cannot bind its socket,
 * so the service starts and has no terminals. But it can only say so once the unit is
 * installed and someone runs `--doctor`. print-service holds the same path at the moment
 * the operator is watching, and said nothing: it would emit a unit pinning a root whose
 * socket needs 113 of 108 available bytes, followed by a copy-paste install hint.
 *
 * Same generator/doctor asymmetry that let an unvalidated `--node` through, and warned
 * about for the same reason: the root may be short enough on the host this file is
 * destined for.
 */
export function socketPathBudgetWarning(userDataPath: string): string | null {
  const budget = checkDaemonSocketPathBudget(userDataPath)
  if (budget.fits) {
    return null
  }
  return `Warning: ${describeDaemonSocketPathOverflow(budget)} ${DAEMON_SOCKET_PATH_REMEDY}`
}

/**
 * launchd captures nothing unless the plist names a file, and no path can be defaulted here
 * that the job is known to be able to open.
 *
 * Both candidates are wrong, for the same reason. `/var/log` is root-owned on macOS while the
 * job runs as a non-root account — `assertNotRoot` guarantees it is not root — so a
 * LaunchDaemon cannot create a file there. And the generating user's home is the run-as
 * account's home only when `--user` did not name somebody else, which this process cannot
 * resolve. Either guess emits a plist whose log the job cannot open, and launchd reports that
 * against the log path rather than against the job: a broken install for a reason the file
 * never states.
 *
 * systemd needs no equivalent — journald captures a unit's output with nothing configured —
 * which is why this asymmetry is stated rather than papered over with a plausible default.
 */
export function launchdLogDestinationWarning(): string {
  return (
    'Warning: this job names no log file, so launchd will not capture orcad’s output. ' +
    'No path is defaulted because none can be shown writable by the run-as account: ' +
    '/var/log is root-owned while the job runs unprivileged, and when --user names another ' +
    'account its home directory cannot be resolved from here. To keep logs, create a file ' +
    'the run-as account owns and add StandardOutPath and StandardErrorPath pointing at it — ' +
    'then pair it with a newsyslog.d entry, because nothing rotates it.'
  )
}

/**
 * A user-scope systemd service needs a running user instance, and the install commands
 * (`systemctl --user`, `loginctl enable-linger`) all fail without one. Appliance hosts
 * routinely have no per-user D-Bus and no `/run/user/<uid>` at all.
 */
export async function userScopeUnavailableWarning(): Promise<string | null> {
  const uid = process.getuid?.()
  if (uid === undefined) {
    return null
  }
  const runtimeDir = join('/run/user', String(uid))
  if (!existsSync(runtimeDir)) {
    return (
      `Warning: no ${runtimeDir}, so this host has no systemd user instance and no user ` +
      'D-Bus session. The install commands below will fail here; generate with ' +
      '--scope system, or install this file on a host where user scope is available.'
    )
  }
  try {
    const probe = await runProcess({
      program: 'systemctl',
      args: ['--user', 'show-environment'],
      timeoutMs: 5_000
    })
    if (probe.code === 0 && !probe.timedOut) {
      return null
    }
    const detail = (probe.stderr || probe.stdout).trim().split('\n')[0]
    return (
      'Warning: the systemd user instance is not available here' +
      `${detail ? ` (${detail})` : ''}. The install commands below will fail; generate ` +
      'with --scope system, or install this file on a host where user scope is available.'
    )
  } catch (error) {
    return (
      'Warning: could not reach the systemd user instance ' +
      `(${error instanceof Error ? error.message : String(error)}). The install commands ` +
      'below will fail here; generate with --scope system instead.'
    )
  }
}

/**
 * The deepest existing ancestor, resolved, with the not-yet-created tail re-appended.
 *
 * Why not plain `realpathSync`: the data root usually does not exist when a service is
 * first generated, and throwing there would be worse than the symlink it is fixing.
 * Components that do not exist cannot themselves be symlinks, so re-appending them is
 * still a fully-resolved path.
 */
export function resolveRealPath(target: string): string {
  const tail: string[] = []
  let current = target
  for (;;) {
    try {
      return join(realpathSync(current), ...tail)
    } catch {
      const parent = dirname(current)
      if (parent === current) {
        return target
      }
      tail.unshift(current.slice(parent.length + 1))
      current = parent
    }
  }
}
