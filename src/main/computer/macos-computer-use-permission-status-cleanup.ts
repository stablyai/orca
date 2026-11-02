import { runProcess } from '@orca/process-host'
import { escapeRegex } from '../../shared/string-utils'

export async function stopMacOSPermissionStatusHelper(statusPath: string): Promise<void> {
  // The unique status path distinguishes this completed probe from concurrent probes and setup helpers.
  await runProcess({
    program: '/usr/bin/pkill',
    args: [
      '-f',
      `(^|[[:space:]/])orca-computer-use-macos[[:space:]]+--permission-status-file[[:space:]]+${escapeRegex(statusPath)}$`
    ],
    timeoutMs: 2_000,
    stdio: 'ignore'
  }).catch(() => undefined)
}
