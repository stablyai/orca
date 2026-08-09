import type { DebugAdapterConfig } from '../../shared/debug-session-types'
import type { SshConnection } from '../ssh/ssh-connection'
import { buildRemoteProcessCommand } from '../ssh/ssh-relay-exec-stream'
import type { DebugAdapterProcess, DebugAdapterProcessHost } from './debug-adapter-process-host'

export type GetSshConnection = (connectionId: string) => SshConnection | undefined

/**
 * Spawns the debug adapter on a remote SSH host by `exec`-replacing a shell
 * over `SshConnection.exec()`'s raw streaming channel — `execCommand`
 * (`src/main/ssh/ssh-relay-exec-command.ts`) buffers output and resolves
 * once on exit, which does not fit a long-lived, bidirectionally-streamed
 * DAP adapter process.
 */
export class SshDebugAdapterProcessHost implements DebugAdapterProcessHost {
  constructor(
    private readonly connectionId: string,
    private readonly getConnection: GetSshConnection
  ) {}

  async spawn(config: DebugAdapterConfig): Promise<DebugAdapterProcess> {
    const connection = this.getConnection(this.connectionId)
    if (!connection) {
      throw new Error(`No SSH connection for "${this.connectionId}"`)
    }
    const command = buildRemoteProcessCommand(config)
    const channel = await connection.exec(command)
    return {
      stdin: channel,
      stdout: channel,
      stderr: channel.stderr,
      kill: () => {
        channel.close()
      }
    }
  }
}
