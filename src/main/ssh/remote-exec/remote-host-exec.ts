import type { Readable } from 'node:stream'
import { execCommand, isSshCommandExitError } from './remote-exec-command'
import type { RemoteHostPlatform } from '../remote-host/ssh-remote-platform'

type HostConnection = Parameters<typeof execCommand>[0]

type HostCommandOptions = {
  signal?: AbortSignal
  timeoutMs?: number
  onStderr?: (stderr: string) => void
  stdin?: Readable
}

export function execHostCommand(
  conn: HostConnection,
  host: RemoteHostPlatform,
  command: string,
  options?: HostCommandOptions
): Promise<string> {
  // Choose wrapper by command dialect; the wrapper itself is POSIX shell.
  return execCommand(conn, command, {
    wrapCommand: host.commandDialect !== 'powershell',
    ...options
  })
}

/** Same dialect wrapper as `execHostCommand`, keeping stderr and the exit code for a probe. */
export async function captureHostCommand(
  conn: Parameters<typeof execCommand>[0],
  host: RemoteHostPlatform,
  command: string,
  options?: HostCommandOptions
): Promise<{ stdout: string; stderr: string; code: number }> {
  let stderr = ''
  try {
    const stdout = await execHostCommand(conn, host, command, {
      ...options,
      onStderr: (text) => {
        stderr = text
        options?.onStderr?.(text)
      }
    })
    return { stdout, stderr, code: 0 }
  } catch (error) {
    if (isSshCommandExitError(error)) {
      return { stdout: error.stdout, stderr, code: error.exitCode }
    }
    throw error
  }
}
