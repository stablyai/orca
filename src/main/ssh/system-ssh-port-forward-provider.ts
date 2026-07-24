import type { SshConnection } from './ssh-connection'
import {
  startSystemSshPortForwardProcess,
  systemSshForwardError
} from './system-ssh-forward-process'
import type {
  PortForwardStartOptions,
  SshPortForwardProvider,
  StartedPortForward
} from './ssh-port-forward-provider'
import { SystemSshOutputTail } from './system-ssh-output-tail'

export class SystemSshPortForwardProvider implements SshPortForwardProvider {
  canHandle(conn: SshConnection): boolean {
    return conn.getClient() === null && conn.usesSystemSshTransport()
  }

  async start(conn: SshConnection, options: PortForwardStartOptions): Promise<StartedPortForward> {
    const target = conn.getTarget()
    const resolvedConfig = conn.getSystemSshResolvedConfig()
    const forward = resolvedConfig
      ? await startSystemSshPortForwardProcess(
          target,
          options.localPort,
          options.remoteHost,
          options.remotePort,
          { resolvedConfig }
        )
      : await startSystemSshPortForwardProcess(
          target,
          options.localPort,
          options.remoteHost,
          options.remotePort
        )

    await forward.waitForStartup()
    const stderr = new SystemSshOutputTail()
    const onStderr = (chunk: Buffer): void => {
      stderr.push(chunk)
    }
    forward.process.stderr?.on('data', onStderr)

    const entry = {
      id: options.id,
      connectionId: options.connectionId,
      localPort: options.localPort,
      remoteHost: options.remoteHost,
      remotePort: options.remotePort,
      label: options.label
    }

    forward.process.once('exit', (code) => {
      forward.process.stderr?.off('data', onStderr)
      options.onUnexpectedClose?.(entry, {
        kind: 'unexpected-exit',
        detail: systemSshForwardError(code, stderr.toString()).message
      })
    })

    return {
      entry,
      close: async () => {
        try {
          await forward.close()
        } finally {
          forward.process.stderr?.off('data', onStderr)
        }
      },
      dispose: () => {
        forward.process.stderr?.off('data', onStderr)
        forward.dispose()
      }
    }
  }
}
