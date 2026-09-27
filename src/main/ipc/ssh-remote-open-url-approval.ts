import { ipcMain, shell } from 'electron'
import { connect } from 'node:net'
import type { Duplex } from 'node:stream'
import { SystemSshPortForwardProvider } from '../ssh/system-ssh-port-forward-provider'
import { consumeRemoteOpenUrlTicket } from '../ssh/remote-open-url-requests'
import { listenOnFreeLoopbackPort, OauthCallbackForwarder } from '../ssh/ssh-oauth-callback-forward'
import { connectionManager } from './ssh-ipc-context'
import type { RemoteOpenUrlApprovalResult } from '../../shared/remote-open-url'

const systemProvider = new SystemSshPortForwardProvider()
let nextTunnelId = 1

function canReach(sshTargetId: string): boolean {
  const conn = connectionManager?.getConnection(sshTargetId)
  return Boolean(conn && (conn.getClient() || systemProvider.canHandle(conn)))
}

// Why not SshPortForwardManager: its forwards are listed in the Ports panel and persisted per
// target. Why opened only now: until the matched callback arrives, nothing may reach the remote
// listener, so there is no long-lived desktop port for another local process to use.
async function openCallbackStream(
  sshTargetId: string,
  remoteHost: string,
  remotePort: number
): Promise<Duplex> {
  const conn = connectionManager?.getConnection(sshTargetId)
  if (!conn) {
    throw new Error('SSH connection is not established')
  }
  const client = conn.getClient()
  if (client) {
    return new Promise((resolve, reject) => {
      client.forwardOut('127.0.0.1', 0, remoteHost, remotePort, (err, channel) =>
        err ? reject(err) : resolve(channel)
      )
    })
  }
  if (!systemProvider.canHandle(conn)) {
    throw new Error('SSH connection is not established')
  }
  // System ssh has no per-connection channel API: a tunnel that serves this one connection only.
  const localPort = await listenOnFreeLoopbackPort()
  const started = await systemProvider.start(conn, {
    id: `oauth-callback-${nextTunnelId++}`,
    connectionId: sshTargetId,
    localHost: '127.0.0.1',
    localPort,
    remoteHost,
    remotePort
  })
  const stream = connect(localPort, '127.0.0.1')
  const release = (): void => void started.close().catch(() => started.dispose())
  stream.once('close', release)
  await new Promise<void>((resolve, reject) => {
    stream.once('connect', resolve)
    stream.once('error', (err) => {
      release()
      reject(err)
    })
  })
  return stream
}

export const oauthCallbackForwarder = new OauthCallbackForwarder({
  canReach,
  openStream: openCallbackStream
})

/**
 * The owner clicked Open on a remote host's request. Only a live ticket minted by main counts,
 * and the URL opened is the one main recorded, never one supplied by the renderer.
 */
export async function approveRemoteOpenUrl(
  requestId: unknown
): Promise<RemoteOpenUrlApprovalResult> {
  const ticket = consumeRemoteOpenUrlTicket(requestId)
  if (!ticket) {
    return { status: 'expired' }
  }
  let forwardedPort: number | null = null
  let forwardMinutes: number | null = null
  if (ticket.callback) {
    const result = await oauthCallbackForwarder.start(ticket.sshTargetId, ticket.callback)
    if (!result.ok) {
      // Why fail closed: without the forward the sign-in would dead-end on a refused redirect.
      return { status: 'forward_failed', reason: result.reason, port: ticket.callback.port }
    }
    forwardedPort = result.port
    forwardMinutes = Math.round(result.lifetimeMs / 60_000)
  }
  await shell.openExternal(new URL(ticket.url).toString())
  return { status: 'opened', forwardedPort, forwardMinutes }
}

export function registerRemoteOpenUrlApprovalHandler(): void {
  ipcMain.handle('browser:approveRemoteOpenUrl', (_event, args: { requestId?: unknown }) =>
    approveRemoteOpenUrl(args?.requestId)
  )
}
