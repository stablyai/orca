import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import { isWindowsRemoteHost, type RemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import { orcadWindowsHostOpCommand } from '../install/orcad-remote-windows-node'
import { ORCAD_SNAPSHOT_MEMBERS } from './orcad-state-snapshot-members'

/** Print newest snapshot-member mtime or UNKNOWN; rollback treats unknown state as potentially modified. */
export function newestStateMtimeCommand(
  host: RemoteHostPlatform,
  userDataDir: string,
  baseDir: string
): string {
  if (isWindowsRemoteHost(host)) {
    return orcadWindowsHostOpCommand(host, baseDir, 'state-newest-mtime', [userDataDir])
  }
  const root = quotePosixShell(userDataDir)
  const paths = ORCAD_SNAPSHOT_MEMBERS.map((member) => `${root}/${quotePosixShell(member)}`).join(
    ' '
  )
  return [
    `newest=$(find ${paths} -type f -exec stat -c %Y {} + 2>/dev/null ||`,
    `find ${paths} -type f -exec stat -f %m {} + 2>/dev/null);`,
    'if [ -z "$newest" ]; then echo UNKNOWN; else',
    `echo "$newest" | sort -n | tail -1; fi`
  ].join(' ')
}

export function parseNewestStateMtimeSeconds(output: string): number | null {
  const value = output.trim().split('\n').pop()?.trim()
  if (!value || !/^\d+$/.test(value)) {
    return null
  }
  return Number.parseInt(value, 10)
}
