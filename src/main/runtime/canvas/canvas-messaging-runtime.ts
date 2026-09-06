import { agentHookServer } from '../../agent-hooks/server'
import type { OrcaRuntimeService } from '../orca-runtime'
import { CanvasMessageJournal } from './canvas-message-journal'
import { CanvasMessageMembership } from './canvas-message-membership'
import { CanvasMessagingService } from './canvas-messaging-service'

const services = new WeakMap<OrcaRuntimeService, CanvasMessagingService>()
const cleanups = new WeakMap<OrcaRuntimeService, () => void>()
export function startCanvasMessaging(runtime: OrcaRuntimeService): void {
  if (
    [...agentHookServer.canvasContexts.snapshot().values()].some((record) =>
      record.bindings.some((binding) => binding.peers?.length)
    )
  ) {
    void getCanvasMessaging(runtime).flush()
  }
}
export function stopCanvasMessaging(runtime: OrcaRuntimeService): void {
  services.get(runtime)?.stop()
  cleanups.get(runtime)?.()
  cleanups.delete(runtime)
  services.delete(runtime)
}
export function getCanvasMessaging(runtime: OrcaRuntimeService): CanvasMessagingService {
  let service = services.get(runtime)
  if (!service) {
    service = new CanvasMessagingService(
      new CanvasMessageJournal(runtime.getOrchestrationDb()),
      new CanvasMessageMembership(agentHookServer.canvasContexts, runtime),
      runtime,
      () => agentHookServer.canvasContexts.managedCliCommand()
    )
    services.set(runtime, service)
    const current = service
    const unsubscribeReplies = agentHookServer.subscribeEnrichedStatus((event) =>
      current.observeAgentHook(event)
    )
    const unsubscribe = agentHookServer.subscribeStatusChanges(() => {
      void current.flush()
    })
    const timer = setInterval(() => void current.flush(), 3000)
    timer.unref()
    cleanups.set(runtime, () => {
      unsubscribe()
      unsubscribeReplies()
      clearInterval(timer)
    })
  }
  return service
}
export function refreshCanvasMessaging(runtime: OrcaRuntimeService, hasPeers: boolean): void {
  if (hasPeers || services.has(runtime)) {
    void getCanvasMessaging(runtime).flush()
  }
}
