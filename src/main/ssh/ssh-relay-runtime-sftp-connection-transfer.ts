import type { Client, SFTPWrapper } from 'ssh2'

import type { SshConnection } from './ssh-connection'
import { openSshRelayRuntimeSftpTreeSession } from './ssh-relay-runtime-sftp-session'
import {
  transferSshRelayRuntimeTreeViaSftp,
  type SshRelayRuntimeSftpTreeSession,
  type SshRelayRuntimeSftpTreeTransferOptions,
  type SshRelayRuntimeSftpTreeTransferResult
} from './ssh-relay-runtime-sftp-tree-transfer'

const TRANSPORT_CLOSE_TIMEOUT_MS = 5_000

export type SshRelayRuntimeBuiltInSftpConnection = Pick<
  SshConnection,
  'getClient' | 'sftp' | 'usesSystemSshTransport'
>

export type SshRelayRuntimeSftpConnectionTransferOptions = Omit<
  SshRelayRuntimeSftpTreeTransferOptions,
  'openSession'
> &
  Readonly<{ connection: SshRelayRuntimeBuiltInSftpConnection }>

function waitForClose(
  emitter: Pick<NodeJS.EventEmitter, 'once' | 'removeListener'>,
  beginClose: () => void,
  timeoutMessage: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: unknown): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      emitter.removeListener('close', onClose)
      if (error === undefined) {
        resolve()
      } else {
        reject(error)
      }
    }
    const onClose = (): void => finish()
    const timer = setTimeout(() => finish(new Error(timeoutMessage)), TRANSPORT_CLOSE_TIMEOUT_MS)
    emitter.once('close', onClose)
    try {
      beginClose()
    } catch (error) {
      finish(error)
    }
  })
}

async function forceCloseCapturedClient(client: Client): Promise<void> {
  await waitForClose(
    client,
    () => client.destroy(),
    'SSH relay runtime owning connection close timed out'
  )
}

async function closeSessionFromReplacedConnection(raw: SFTPWrapper, client: Client): Promise<void> {
  try {
    await waitForClose(
      raw,
      () => raw.end(),
      'SSH relay runtime replaced connection SFTP close timed out'
    )
  } catch (error) {
    try {
      await forceCloseCapturedClient(client)
    } catch (forceError) {
      throw new AggregateError(
        [error, forceError],
        'SSH relay runtime replaced connection cleanup failed'
      )
    }
    throw error
  }
}

function validateConnection(connection: SshRelayRuntimeBuiltInSftpConnection): void {
  if (
    !connection ||
    typeof connection.getClient !== 'function' ||
    typeof connection.sftp !== 'function' ||
    typeof connection.usesSystemSshTransport !== 'function'
  ) {
    throw new Error('SSH relay runtime SFTP connection boundary is invalid')
  }
  if (connection.usesSystemSshTransport()) {
    throw new Error('SSH relay runtime SFTP transfer requires the built-in SSH transport')
  }
}

export async function openSshRelayRuntimeSftpTreeSessionForConnection(
  connection: SshRelayRuntimeBuiltInSftpConnection,
  signal: AbortSignal
): Promise<SshRelayRuntimeSftpTreeSession> {
  validateConnection(connection)
  signal.throwIfAborted()
  const capturedClient = connection.getClient()
  if (!capturedClient) {
    throw new Error('SSH relay runtime SFTP transfer requires a connected built-in SSH client')
  }

  return openSshRelayRuntimeSftpTreeSession({
    signal,
    openRawSession: async (exactSignal) => {
      if (connection.getClient() !== capturedClient) {
        throw new Error('SSH relay runtime SFTP connection changed before channel open')
      }
      const raw = await connection.sftp(exactSignal)
      if (connection.getClient() !== capturedClient) {
        // Why: never return a channel whose owning connection generation is no longer current.
        await closeSessionFromReplacedConnection(raw, capturedClient)
        throw new Error('SSH relay runtime SFTP connection changed during channel open')
      }
      return raw
    },
    // Why: escalation may tear down only the transport that owns the stuck raw callback.
    forceCloseConnection: () => forceCloseCapturedClient(capturedClient)
  })
}

export function transferSshRelayRuntimeTreeOverSftpConnection(
  options: SshRelayRuntimeSftpConnectionTransferOptions
): Promise<SshRelayRuntimeSftpTreeTransferResult> {
  const { connection, ...treeOptions } = options
  return transferSshRelayRuntimeTreeViaSftp({
    ...treeOptions,
    openSession: (signal) => openSshRelayRuntimeSftpTreeSessionForConnection(connection, signal)
  })
}

export const SSH_RELAY_RUNTIME_SFTP_CONNECTION_LIMITS = Object.freeze({
  transportCloseTimeoutMs: TRANSPORT_CLOSE_TIMEOUT_MS
})
