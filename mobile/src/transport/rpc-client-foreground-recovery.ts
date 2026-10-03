import { isStaleForegroundDial } from './rpc-stale-dial'
import type { ConnectionState } from './types'
import type { RpcClientSocketSession } from './rpc-client-socket-session'
import type { RpcClientSocketFactory } from './rpc-client-socket-factory'
import type { RpcClientSocketCloseController } from './rpc-client-socket-close-controller'
import type { RpcClientReconnectSchedule } from './rpc-client-reconnect-schedule'

export function recoverRpcClientOnForeground(args: {
  closed: boolean
  getState(): ConnectionState
  probe(): void
  session: RpcClientSocketSession | null
  factory: RpcClientSocketFactory
  socketClose: RpcClientSocketCloseController
  reconnect: RpcClientReconnectSchedule
}): void {
  if (args.closed) {
    return
  }
  if (args.getState() === 'connected') {
    console.log('[net] foreground — probing live connection')
    args.probe()
    return
  }
  const dialAgeMs = Date.now() - args.factory.getDialStartedAt()
  let abandoned = false
  if (args.session && isStaleForegroundDial(args.getState(), dialAgeMs)) {
    console.log('[net] foreground — abandoning stale dial', {
      state: args.getState(),
      dialAgeMs
    })
    args.socketClose.forceClose(args.session)
    abandoned = true
  }
  if (args.getState() === 'reconnecting') {
    console.log('[net] foreground — restarting reconnect loop', {
      attempt: args.reconnect.getAttempt(),
      hadTimer: args.reconnect.hasTimer()
    })
    args.reconnect.redialNow(!abandoned)
  }
}
