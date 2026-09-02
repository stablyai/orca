/**
 * Finding the supervisor service definitions installed on this host.
 *
 * Split out of `orcad-service-command.ts` so neither file has to carry both jobs: this one
 * answers what is on disk, that one decides what to do about it.
 *
 * Presence and readability are separate answers here, deliberately. `existsSync` succeeds on
 * a file the caller cannot open — a traversable parent is enough — so folding both into one
 * catch reported an installed-but-unreadable unit as an absent one, and then told the
 * operator to redo an install that had already succeeded.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  ORCAD_LAUNCHD_LABEL,
  ORCAD_SYSTEMD_UNIT_NAME,
  type SupervisorPlatform,
  type SupervisorScope
} from '../../shared/supervisor-service-render'
import type { SupervisorServiceFile } from '../../shared/supervisor-service-audit'

/** The conventional locations, both scopes, for the platform we are on. */
export function candidateServicePaths(
  platform: SupervisorPlatform
): { path: string; scope: SupervisorScope }[] {
  if (platform === 'launchd') {
    return [
      { path: join('/Library/LaunchDaemons', `${ORCAD_LAUNCHD_LABEL}.plist`), scope: 'system' },
      {
        path: join(homedir(), 'Library', 'LaunchAgents', `${ORCAD_LAUNCHD_LABEL}.plist`),
        scope: 'user'
      }
    ]
  }
  return [
    { path: join('/etc/systemd/system', ORCAD_SYSTEMD_UNIT_NAME), scope: 'system' },
    { path: join('/usr/lib/systemd/system', ORCAD_SYSTEMD_UNIT_NAME), scope: 'system' },
    { path: join(homedir(), '.config', 'systemd', 'user', ORCAD_SYSTEMD_UNIT_NAME), scope: 'user' }
  ]
}

/**
 * Why infer rather than default to system: mislabelling a user-scope file makes the audit
 * report its (correct) missing run-as account as critical.
 */
export function inferScopeFromPath(path: string): SupervisorScope {
  const normalized = path.split('\\').join('/')
  return /\/systemd\/user\/|\/LaunchAgents\//i.test(normalized) ? 'user' : 'system'
}

/** A candidate that is present but could not be read. Never folded into "not found". */
export type UnreadableServiceFile = { path: string; reason: string }

export type ServiceFileDiscovery = {
  files: SupervisorServiceFile[]
  unreadable: UnreadableServiceFile[]
}

/**
 * Reads every candidate rather than stopping at the first: two definitions targeting one
 * data root is itself the highest-severity finding, and stopping early would hide it.
 *
 * An explicit path SELECTS rather than extends — the difference between "audit this
 * definition" and "audit the usual ones and also this". Extending looked harmless and was
 * not: point `--service-path` at the file conventional discovery already finds, which is the
 * obvious thing to do when you want a report about your actual install, and the same file is
 * collected twice. `auditDuplicates` then sees two paths sharing one data root and reports
 * `multiple_services_one_root` as CRITICAL with exit 1, while `files.length` stops being 1
 * so every live probe is skipped as ambiguous. A false critical and a silently degraded
 * report, both produced by naming the file you wanted audited.
 *
 * Presence and readability are separated deliberately. `existsSync` succeeds on a file the
 * caller cannot open — a traversable directory is enough — so a unit installed with a
 * restrictive mode used to fall into the same catch as one that was never there, and the
 * audit then told the operator to run `--print-service`: to redo an install that had
 * already succeeded. Observed on Synology DSM, where root's umask is 0077 and
 * `sudo tee` therefore writes /etc/systemd/system/orcad.service mode 600 while every unit
 * shipped with the OS is 644.
 */
export function collectServiceFiles(
  platform: SupervisorPlatform,
  explicitPaths: string[] = []
): ServiceFileDiscovery {
  const candidates =
    explicitPaths.length > 0
      ? explicitPaths.map((path) => ({ path, scope: inferScopeFromPath(path) }))
      : candidateServicePaths(platform)
  const files: SupervisorServiceFile[] = []
  const unreadable: UnreadableServiceFile[] = []
  for (const candidate of candidates) {
    let present = false
    try {
      present = existsSync(candidate.path) && statSync(candidate.path).isFile()
    } catch (error) {
      // Cannot even stat it: that is a permission answer about a path, not an absence.
      unreadable.push({ path: candidate.path, reason: errnoOf(error) })
      continue
    }
    if (!present) {
      continue
    }
    try {
      files.push({
        path: candidate.path,
        text: readFileSync(candidate.path, 'utf8'),
        platform,
        scope: candidate.scope
      })
    } catch (error) {
      unreadable.push({ path: candidate.path, reason: errnoOf(error) })
    }
  }
  return { files, unreadable }
}

function errnoOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' ? code : 'unknown error'
}
