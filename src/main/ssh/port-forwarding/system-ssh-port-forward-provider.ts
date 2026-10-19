import type { SshConnection } from '../connection/ssh-connection'
import type { SystemSshBuildArgsOptions } from '../system-transport/system-ssh-args'
import {
  startSystemSshPortForwardProcess,
  systemSshForwardError
} from '../system-transport/system-ssh-forward-process'
import type {
  ForwardChannelOpenFailure,
  PortForwardStartOptions,
  SshPortForwardProvider,
  StartedPortForward
} from './ssh-port-forward-provider'

/** The build options a system-SSH forward spawns with; orphan recovery matches that argv. */
export function systemSshForwardBuildArgsOptions(conn: SshConnection): SystemSshBuildArgsOptions {
  // The managed tunnel reads the channel answer from stderr (lastChannelOpenFailure).
  return { ...conn.getSystemSshBuildArgsOptions(), logChannelFailures: true }
}

export class SystemSshPortForwardProvider implements SshPortForwardProvider {
  canHandle(conn: SshConnection): boolean {
    return conn.getClient() === null && conn.usesSystemSshTransport()
  }

  async start(conn: SshConnection, options: PortForwardStartOptions): Promise<StartedPortForward> {
    const target = conn.getTarget()
    const forward = await startSystemSshPortForwardProcess(
      target,
      options.localPort,
      options.remoteHost,
      options.remotePort,
      systemSshForwardBuildArgsOptions(conn)
    )

    await forward.waitForStartup()
    // Why: this stderr stays attached for the forward's whole lifetime but is
    // only used to build the exit-error detail, so keep a bounded tail — a chatty
    // remote sshd could otherwise grow it unbounded on a long-lived forward
    // (mirrors MAX_RELAY_STARTUP_BUFFER_BYTES in ssh-relay-sentinel).
    const MAX_STDERR_TAIL_BYTES = 64 * 1024
    let stderr = ''
    const onStderr = (chunk: Buffer): void => {
      stderr += chunk.toString('utf-8')
      if (stderr.length > MAX_STDERR_TAIL_BYTES) {
        stderr = stderr.slice(-MAX_STDERR_TAIL_BYTES)
      }
    }
    forward.process.stderr?.on('data', onStderr)

    const entry = {
      id: options.id,
      connectionId: options.connectionId,
      localPort: forward.localPort,
      remoteHost: options.remoteHost,
      remotePort: options.remotePort,
      label: options.label
    }

    forward.process.once('exit', (code) => {
      forward.process.stderr?.off('data', onStderr)
      options.onUnexpectedClose?.(entry, {
        kind: 'unexpected-exit',
        detail: systemSshForwardError(code, stderr, forward.localPort).message
      })
    })

    return {
      entry,
      lastChannelOpenFailure: () => lastChannelOpenFailure(stderr),
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

// OpenSSH logs each refused direct-tcpip open as `channel N: open failed: <reason>: <message>`.
const CHANNEL_OPEN_FAILED = /open failed: (administratively prohibited|connect failed)/g

export function lastChannelOpenFailure(stderr: string): ForwardChannelOpenFailure | null {
  const reason = [...stderr.matchAll(CHANNEL_OPEN_FAILED)].at(-1)?.[1]
  return reason === undefined
    ? null
    : reason === 'connect failed'
      ? 'connect-failed'
      : 'administratively-prohibited'
}
