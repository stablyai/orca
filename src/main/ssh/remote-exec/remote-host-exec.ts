import type { RemoteInstallTransport } from '../../managed-server/install/remote-install-transport'
import { execCommand } from './remote-exec-command'
import type { RemoteHostPlatform } from '../ssh-remote-platform'

export function execHostCommand(
  conn: RemoteInstallTransport,
  host: RemoteHostPlatform,
  command: string,
  options?: { signal?: AbortSignal; timeoutMs?: number; onStderr?: (stderr: string) => void }
): Promise<string> {
  // Choose wrapper by command dialect; the wrapper itself is POSIX shell.
  return execCommand(conn, command, {
    wrapCommand: host.commandDialect !== 'powershell',
    ...options
  })
}
