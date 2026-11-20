// A subscriber's status stream: a snapshot, then every revision the installation publishes.

import type { RpcContext } from '../../core'
import type { ManagedRuntimeInstallState } from '../../../../../shared/agent-launch/installation/managed-runtime-install'
import type { ManagedRuntimeInstallation } from '../../../../node-runtime/managed-runtime-installation'
import { bindStructuredAgentSessionStream } from '../structured-sessions/subscriptions/structured-agent-session-status-stream'

export async function streamManagedRuntimeInstall(
  agent: string,
  ctx: RpcContext,
  emit: (state: ManagedRuntimeInstallState) => void,
  installation: ManagedRuntimeInstallation
): Promise<void> {
  // A failed first read fails the subscribe; a later one keeps the client's last snapshot.
  const first = await installation.status()
  let shown = first.revision
  const frame = ctx.requestId ? `:${ctx.requestId}` : ''
  const subscriptionId = `managedRuntime:${ctx.connectionId ?? 'local'}:${agent}${frame}`
  let dispose = (): void => {}
  const stream = bindStructuredAgentSessionStream(ctx, subscriptionId, () => dispose())
  if (stream.isClosed()) {
    return
  }
  let reading = false
  let again = false
  // One read at a time; revisions during it coalesce into one more read.
  const follow = async (): Promise<void> => {
    again = true
    if (reading) {
      return
    }
    reading = true
    try {
      while (again && !stream.isClosed()) {
        again = false
        const next = await installation.status(false)
        if (next.revision !== shown && !stream.isClosed()) {
          shown = next.revision
          emit(next)
        }
      }
    } catch (error) {
      console.warn(`[managed-runtime] ${agent} status not read for a subscriber:`, error)
    } finally {
      reading = false
    }
  }
  dispose = installation.subscribe(() => void follow())
  emit(first)
  // Catches a revision between the first read and the subscribe.
  void follow()
}
