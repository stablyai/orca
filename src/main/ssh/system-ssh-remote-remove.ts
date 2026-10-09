import type { SshTarget } from '../../shared/ssh-types'
import { shellEscape } from './ssh-connection-utils'
import {
  getSystemSshBuildArgsFromOperationOptions,
  type SystemSshBuildArgsOptions
} from './system-ssh-args'
import { spawnSystemSshCommand } from './system-ssh-command'
import { awaitWithSystemSshAbort, waitForChannelClose } from './system-ssh-operation-lifecycle'

/**
 * Removes one entry an upload created on a POSIX host, never recursively: rmdir
 * refuses a non-empty directory, and the file guard refuses a node swapped in for ours.
 */
export async function removeCreatedEntryViaSystemSsh(
  target: SshTarget,
  remotePath: string,
  kind: 'file' | 'directory',
  options?: SystemSshBuildArgsOptions & { signal?: AbortSignal }
): Promise<void> {
  const channel = spawnSystemSshCommand(
    target,
    makeRemoveCreatedEntryCommand(remotePath, kind),
    getSystemSshBuildArgsFromOperationOptions(options)
  )
  await awaitWithSystemSshAbort(
    options?.signal,
    () => channel.close(),
    waitForChannelClose(channel, `remove ${remotePath}`)
  )
}

export function makeRemoveCreatedEntryCommand(
  remotePath: string,
  kind: 'file' | 'directory'
): string {
  const path = shellEscape(remotePath)
  return kind === 'directory'
    ? `rmdir -- ${path}`
    : `[ -f ${path} ] && [ ! -L ${path} ] && rm -f -- ${path}`
}
