import type { HerdrPtyBinding, HerdrPtyTarget } from './herdr-pty-types'
import { HerdrRuntimeManager } from './herdr-runtime-manager'
import { bindController, detachBinding } from './herdr-pty-provider-binding'
import { disposeProvider } from './herdr-pty-provider-lifecycle'
import { waitForFirstHerdrFrame } from './herdr-pty-codec'
import type { HerdrHostTransport, HerdrTerminalFrame } from './herdr-runtime-contract'

export function getRuntime(
  target: HerdrPtyTarget,
  managers: Map<string, HerdrRuntimeManager>,
  transportForTarget: (target: HerdrPtyTarget) => HerdrHostTransport,
  sharedName: (() => string | undefined) | undefined
): {
  manager: HerdrRuntimeManager
  transport: HerdrHostTransport
} {
  const transport = transportForTarget(target)
  let manager = managers.get(target.identity.hostId)
  if (!manager) {
    manager = new HerdrRuntimeManager(transport, sharedName)
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
