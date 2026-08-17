import type { PtyDataEvent } from '../../types'
import type { HerdrPtyBinding, HerdrPtyTarget } from './herdr-pty-types'
import { HerdrRuntimeManager, type HerdrLivePaneListener } from './herdr-runtime-manager'
import { bindController, detachBinding } from './herdr-pty-provider-binding'
import { disposeProvider } from './herdr-pty-provider-lifecycle'
import { waitForFirstHerdrFrame } from './herdr-pty-codec'
import type { HerdrHostTransport, HerdrTerminalFrame } from './herdr-runtime-contract'

export function getRuntime(
  target: HerdrPtyTarget,
  managers: Map<string, HerdrRuntimeManager>,
  transportForTarget: (target: HerdrPtyTarget) => HerdrHostTransport,
  sharedName: (() => string | undefined) | undefined,
  onLivePaneIds?: HerdrLivePaneListener
): {
  manager: HerdrRuntimeManager
  transport: HerdrHostTransport
} {
  const transport = transportForTarget(target)
  let manager = managers.get(target.identity.hostId)
  if (!manager) {
    manager = new HerdrRuntimeManager(transport, sharedName, onLivePaneIds)
    managers.set(target.identity.hostId, manager)
  }
  return { manager, transport }
}

export function createBinding(
  input: Omit<HerdrPtyBinding, 'sequenceChars' | 'snapshot' | 'detached' | 'unsubscribe'>,
  bindings: Map<string, HerdrPtyBinding>
): HerdrPtyBinding {
  const previous = bindings.get(input.id)
  if (previous) {
    detachBinding(previous, bindings)
  }
  const binding = bindController(input)
  bindings.set(input.id, binding)
  return binding
}

export function awaitFirstFrame(
  binding: HerdrPtyBinding,
  emitData: (payload: { id: string; data: string; sequenceChars: number }) => void,
  emitExit: (payload: { id: string; code: number }) => void,
  detach: () => void
): Promise<{ frame: HerdrTerminalFrame; data: string } | null> {
  return waitForFirstHerdrFrame(binding, { emitData, emitExit, detach })
}

export function releaseBinding(
  binding: HerdrPtyBinding,
  bindings: Map<string, HerdrPtyBinding>
): void {
  detachBinding(binding, bindings)
}

export function disposeAll(
  bindings: Map<string, HerdrPtyBinding>,
  managers: Map<string, HerdrRuntimeManager>,
  disposeBase: () => void
): void {
  disposeProvider(bindings, managers)
  disposeBase()
}

export function retireMissingHerdrPanes(
  bindings: Map<string, HerdrPtyBinding>,
  sessionName: string,
  livePaneIds: ReadonlySet<string>,
  retire: (binding: HerdrPtyBinding) => void
): void {
  for (const binding of bindings.values()) {
    if (binding.sessionName !== sessionName || livePaneIds.has(binding.paneId)) {
      continue
    }
    retire(binding)
  }
}

export function emitHerdrPtyData(
  listeners: Set<(payload: PtyDataEvent) => void>,
  payload: PtyDataEvent
): void {
  for (const listener of listeners) {
    listener(payload)
  }
}

export function emitHerdrPtyExit(
  listeners: Set<(payload: { id: string; code: number; incarnationId?: string }) => void>,
  bindings: Map<string, HerdrPtyBinding>,
  payload: { id: string; code: number; incarnationId?: string }
): void {
  const incarnationId = payload.incarnationId ?? bindings.get(payload.id)?.incarnationId
  const event = incarnationId ? { ...payload, incarnationId } : payload
  for (const listener of listeners) {
    listener(event)
  }
}

export function emitHerdrPtyReplay(
  listeners: Set<(payload: { id: string; data: string }) => void>,
  payload: { id: string; data: string }
): void {
  for (const listener of listeners) {
    listener(payload)
  }
}

export function killAllHerdrBindings(bindings: Map<string, HerdrPtyBinding>): void {
  for (const binding of bindings.values()) {
    binding.transport
      .request(binding.sessionName, 'pane.close', { pane_id: binding.paneId })
      .catch(() => {})
  }
  bindings.clear()
}
