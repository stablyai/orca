import type { AgentHookServer } from '../agent-hooks/server'
import type { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import { AGENT_HOOK_INFER_INTERRUPT_METHOD } from '../../shared/agent-hook-interrupt-reconciliation'

/** A host revision proves this relay supports the command; older relays keep the legacy path. */
export function bindRemoteClaudeInterruptReconciliation(
  server: Pick<AgentHookServer, 'subscribeRemoteInterruptRequests'>,
  mux: Pick<SshChannelMultiplexer, 'request' | 'isDisposed'>,
  connectionId: string,
  isCurrent: () => boolean
): () => void {
  return server.subscribeRemoteInterruptRequests((command) => {
    if (command.connectionId !== connectionId || !isCurrent() || mux.isDisposed()) {
      return
    }
    void mux.request(AGENT_HOOK_INFER_INTERRUPT_METHOD, command.request).catch((error) => {
      if (isCurrent() && !mux.isDisposed()) {
        console.warn('[agent-hooks] remote interrupt reconciliation failed', error)
      }
    })
  })
}
