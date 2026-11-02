import type { RemoteAgentInterruptDispatch } from '../../../shared/agent-hook-interrupt-reconciliation'

export function dispatchRemoteInterruptListeners(
  listeners: Set<(command: RemoteAgentInterruptDispatch) => void>,
  command: RemoteAgentInterruptDispatch
): void {
  for (const listener of listeners) {
    try {
      listener(command)
    } catch (error) {
      console.warn('[agent-hooks] remote interrupt dispatch failed', error)
    }
  }
}
