/**
 * Host facts the doctor reads off the filesystem rather than out of a supervisor.
 *
 * Deliberately not gated by `--no-probe`: that flag means "do not shell out to systemctl,
 * launchctl or a socket", and these are stats and a config read. The doctor already reads
 * the unit file itself, so refusing to stat the path that file names would be an odd line
 * to draw — and both checks stay useful on a host where every subprocess probe is refused.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ExecTargetState, JournalState, Probe } from '../../shared/supervisor-service-probe'
import {
  readExecTarget,
  readPinnedUserData,
  readSystemdKey,
  type SupervisorServiceFile
} from '../../shared/supervisor-service-file-read'
import { resolveRealPath } from './supervisor-generation-warnings'

/**
 * Two spellings of one directory are not a split profile. Since the generator started
 * pinning a realpath, a host whose data root sits behind a symlink — DSM's
 * /var/services/homes -> /volume2/homes — otherwise reports a mismatch on every run.
 */
export function observeDataRootIdentity(
  file: SupervisorServiceFile,
  expected: string
): Probe<boolean> | undefined {
  const pinned = readPinnedUserData(file)
  if (pinned === null) {
    // Nothing pinned is its own (critical) finding; there is no identity to compare.
    return undefined
  }
  return { status: 'observed', value: resolveRealPath(pinned) === resolveRealPath(expected) }
}

export function observeExecTarget(file: SupervisorServiceFile): Probe<ExecTargetState> {
  const target = readExecTarget(file)
  if (!target) {
    return { status: 'unavailable', reason: 'the definition names no command to run' }
  }
  return {
    status: 'observed',
    value: {
      interpreter: target.interpreter,
      interpreterExists: existsSync(target.interpreter),
      script: target.script,
      scriptExists: target.script === null || existsSync(target.script)
    }
  }
}

/** Drop-ins win over the main file, and a later drop-in wins over an earlier one. */
const JOURNALD_CONFIG = '/etc/systemd/journald.conf'
const JOURNALD_DROPIN_DIRS = ['/etc/systemd/journald.conf.d', '/run/systemd/journald.conf.d']

function journaldConfigFiles(): string[] {
  const files = existsSync(JOURNALD_CONFIG) ? [JOURNALD_CONFIG] : []
  for (const dir of JOURNALD_DROPIN_DIRS) {
    try {
      files.push(
        ...readdirSync(dir)
          .filter((name) => name.endsWith('.conf'))
          .sort()
          .map((name) => join(dir, name))
      )
    } catch {
      // An absent or unreadable drop-in directory is normal, not a failure to report.
    }
  }
  return files
}

/**
 * Why the default matters: journald's own default is `auto`, which is persistent only when
 * /var/log/journal exists. Reporting the effective mode without that directory check would
 * turn a real "logs do not survive a reboot" into a clean bill of health.
 */
export function observeJournal(file: SupervisorServiceFile): Probe<JournalState> {
  const unitUsesJournal =
    file.platform === 'systemd' &&
    ['StandardOutput', 'StandardError'].some((key) =>
      (readSystemdKey(file.text, key) ?? '').startsWith('journal')
    )
  let storage: string | null = null
  for (const path of journaldConfigFiles()) {
    try {
      const declared = /^\s*Storage\s*=\s*(\S+)/m.exec(readFileSync(path, 'utf8'))
      if (declared) {
        storage = declared[1].trim()
      }
    } catch {
      // Unreadable config is not evidence of any particular storage mode.
    }
  }
  if (storage === null) {
    storage = existsSync('/var/log/journal') ? 'persistent' : 'volatile'
  } else if (storage === 'auto') {
    storage = existsSync('/var/log/journal') ? 'persistent' : 'volatile'
  }
  return { status: 'observed', value: { storage, unitUsesJournal } }
}
