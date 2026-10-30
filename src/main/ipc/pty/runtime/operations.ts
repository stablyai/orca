import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { IPtyProvider } from '../../../providers/pty-provider-contract'
import { LocalPtyProvider } from '../../../providers/local-pty-provider'
import { ptyOwnership } from '../provider/ownership-state'
import { ptySizes } from '../delivery/visibility-state'
import { rendererSerializerReadiness } from '../pane/serializer-state'
import { getProviderForPty, localProvider, resolvePtyExecutionHost } from '../provider/registry'
import { inspectPtyProviderProcess } from '../../../providers/pty-process-inspection'
import type { PtyRuntimeControllerDeps } from './controller-deps'
import {
  writeRefused,
  writeUnverifiable,
  isSettledWrite,
  type WriteSettlement
} from '../../../../shared/pty-write-settlement'
import { isDrivingInputKind, type TerminalInputKind } from '../../../../shared/terminal-input-kind'

type RuntimeWriteDeps = Pick<PtyRuntimeControllerDeps, 'runtime'>

export function writePtyFromRuntimeController(
  deps: RuntimeWriteDeps,
  ptyId: string,
  data: string,
  inputKind: TerminalInputKind
): boolean
export function writePtyFromRuntimeController(
  deps: RuntimeWriteDeps,
  ptyId: string,
  data: string,
  inputKind: TerminalInputKind,
  options: { waitForSettlement: true }
): WriteSettlement | Promise<WriteSettlement>
export function writePtyFromRuntimeController(
  deps: RuntimeWriteDeps,
  ptyId: string,
  data: string,
  inputKind: TerminalInputKind,
  options?: { waitForSettlement: true }
): boolean | WriteSettlement | Promise<WriteSettlement> {
  const observeAcceptedInput = (): void => {
    if (isDrivingInputKind(inputKind) && ptyOwnership.get(ptyId) === LOCAL_EXECUTION_HOST_ID) {
      deps.runtime?.observeClaudeTerminalEvidence?.(ptyId, { kind: 'input', data })
    }
  }
  let provider: IPtyProvider
  try {
    provider = getProviderForPty(ptyId)
  } catch {
    return options?.waitForSettlement ? writeRefused('provider_unavailable') : false
  }
  if (options?.waitForSettlement) {
    // Refuse unsupported settlement before effects; fire-and-forget acceptance cannot clear durable mailbox reservations.
    if (!provider.writeWithSettlement) {
      return writeRefused('provider_cannot_settle')
    }
    deps.runtime?.terminalRunFacts?.recordInput(ptyId, inputKind, data)
    try {
      const result = provider.writeWithSettlement(ptyId, data)
      const observe = (settlement: WriteSettlement): WriteSettlement => {
        if (settlement.outcome === 'accepted') {
          observeAcceptedInput()
        }
        return settlement
      }
      return isSettledWrite(result) ? observe(result) : result.then(observe)
    } catch {
      // A synchronous throw cannot prove the transport took nothing.
      return writeUnverifiable('provider_threw_after_handoff', true)
    }
  }
  deps.runtime?.terminalRunFacts?.recordInput(ptyId, inputKind, data)
  try {
    const accepted = provider.write(ptyId, data) !== false
    if (accepted) {
      observeAcceptedInput()
    }
    return accepted
  } catch {
    return false
  }
}

export async function probePtyLivenessFromRuntimeController(
  deps: PtyRuntimeControllerDeps,
  ptyId: string
): Promise<boolean | null> {
  try {
    // A local provider cannot prove remote-host absence.
    if (isRemoteRuntimePtyId(ptyId)) {
      return null
    }
    // Pre-swap fallback cannot authoritatively answer for restored daemon PTYs.
    const startupPromise = deps.getLocalPtyProviderStartupPromise(resolvePtyExecutionHost(ptyId))
    if (startupPromise) {
      await startupPromise
    }
    const provider = getProviderForPty(ptyId)
    if (provider.probePtyLiveness) {
      return await provider.probePtyLiveness(ptyId)
    }
    // Only in-process providers prove sole ownership without a liveness probe (#12393).
    if (provider instanceof LocalPtyProvider) {
      return provider.hasPty(ptyId)
    }
    return null
  } catch {
    return null
  }
}

export async function attachPtyFromRuntimeController(
  deps: PtyRuntimeControllerDeps,
  ptyId: string
): Promise<boolean> {
  if (resolvePtyExecutionHost(ptyId) !== LOCAL_EXECUTION_HOST_ID) {
    return false
  }
  let provider: IPtyProvider
  try {
    provider = getProviderForPty(ptyId)
  } catch {
    return false
  }
  if (provider !== localProvider || provider instanceof LocalPtyProvider) {
    return false
  }
  try {
    const sequenceBeforeProviderAttach = deps.runtime?.getPtyOutputSequence?.(ptyId) ?? 0
    const attachResult = await provider.attach(ptyId)
    if (attachResult?.providerSequence) {
      deps.runtime?.synchronizePtyOutputSequenceFromProvider?.(
        ptyId,
        attachResult.providerSequence,
        sequenceBeforeProviderAttach
      )
    }
    if (attachResult?.lastTitle) {
      deps.runtime?.seedTerminalRestoreTail?.(ptyId, { lastTitle: attachResult.lastTitle })
    }
    return true
  } catch {
    return false
  }
}

export async function getForegroundProcessFromRuntimeController(ptyId: string) {
  try {
    return await getProviderForPty(ptyId).getForegroundProcess(ptyId)
  } catch {
    return null
  }
}

export async function inspectProcessFromRuntimeController(
  ptyId: string,
  options?: { expectedIncarnationId?: string }
) {
  return inspectPtyProviderProcess(getProviderForPty(ptyId), ptyId, options)
}

export async function confirmForegroundProcessFromRuntimeController(ptyId: string) {
  try {
    const provider = getProviderForPty(ptyId)
    // Cached foreground identity cannot resolve a fresh shell conflict.
    return (await provider.confirmForegroundProcess?.(ptyId)) ?? null
  } catch {
    return null
  }
}

export async function confirmShellForegroundFromRuntimeController(ptyId: string) {
  try {
    return (await getProviderForPty(ptyId).confirmShellForeground?.(ptyId)) ?? false
  } catch {
    return false
  }
}

export async function getCwdFromRuntimeController(ptyId: string) {
  try {
    const cwd = await getProviderForPty(ptyId).getCwd(ptyId)
    return cwd || null
  } catch {
    return null
  }
}

export async function hasChildProcessesFromRuntimeController(ptyId: string) {
  try {
    return await getProviderForPty(ptyId).hasChildProcesses(ptyId)
  } catch {
    return false
  }
}

export async function clearBufferFromRuntimeController(
  deps: PtyRuntimeControllerDeps,
  ptyId: string
): Promise<void> {
  // Clear renderer and provider histories so mobile resubscribe cannot restore stale output.
  if (deps.mainWindow && !deps.mainWindow.isDestroyed()) {
    deps.mainWindow.webContents.send('pty:clearBuffer:request', { ptyId })
  }
  try {
    await getProviderForPty(ptyId).clearBuffer(ptyId)
  } catch {
    /* best effort: renderer clear still handles local PTYs */
  }
}

export async function resetInputModesFromRuntimeController(
  deps: PtyRuntimeControllerDeps,
  ptyId: string
): Promise<void> {
  // Remote reset must also ground this host window's pane.
  if (deps.mainWindow && !deps.mainWindow.isDestroyed()) {
    deps.mainWindow.webContents.send('pty:resetInputModes:request', { ptyId })
  }
  try {
    await getProviderForPty(ptyId).resetInputModes(ptyId)
  } catch {
    /* best effort: an older daemon or relay rejects the request */
  }
}

const settledLocalPtyProviderStartups = new WeakSet<Promise<void>>()
const watchedLocalPtyProviderStartups = new WeakSet<Promise<void>>()

function readReadyPtyProvider(
  deps: PtyRuntimeControllerDeps,
  ptyId: string,
  read: (provider: IPtyProvider) => boolean | null
): boolean | null {
  try {
    // A local provider cannot prove remote-host absence.
    if (isRemoteRuntimePtyId(ptyId)) {
      return null
    }
    const startupPromise = deps.getLocalPtyProviderStartupPromise(resolvePtyExecutionHost(ptyId))
    if (startupPromise && !settledLocalPtyProviderStartups.has(startupPromise)) {
      // Sync probes cannot await daemon handoff; report unknown until it settles (docs/reference/ssh-execution-boundary.md).
      if (!watchedLocalPtyProviderStartups.has(startupPromise)) {
        watchedLocalPtyProviderStartups.add(startupPromise)
        const markSettled = (): void => {
          settledLocalPtyProviderStartups.add(startupPromise)
        }
        startupPromise.then(markSettled, markSettled)
      }
      return null
    }
    return read(getProviderForPty(ptyId))
  } catch {
    return null
  }
}

export function hasPtyFromRuntimeController(deps: PtyRuntimeControllerDeps, ptyId: string) {
  return readReadyPtyProvider(deps, ptyId, (provider) => provider.hasPty?.(ptyId) ?? null)
}

export function getPtyAvailabilityFromRuntimeController(
  deps: PtyRuntimeControllerDeps,
  ptyId: string
): boolean | null {
  return readReadyPtyProvider(
    deps,
    ptyId,
    (provider) => provider.getPtyAvailability?.(ptyId) ?? null
  )
}

export function resizePtyFromRuntimeController(ptyId: string, cols: number, rows: number): boolean {
  try {
    getProviderForPty(ptyId).resize(ptyId, cols, rows)
    ptySizes.set(ptyId, { cols, rows })
    return true
  } catch {
    return false
  }
}

export function hasRendererSerializerFromRuntimeController(ptyId: string): boolean {
  // Renderer readiness decides whether its restore or the daemon snapshot seeds history.
  return rendererSerializerReadiness.has(ptyId)
}

export function getRendererSerializerGenerationFromRuntimeController(ptyId: string) {
  return rendererSerializerReadiness.generation(ptyId)
}

export function waitForRendererSerializerFromRuntimeController(
  ptyId: string,
  afterGeneration = 0,
  timeoutMs?: number,
  signal?: AbortSignal
) {
  return rendererSerializerReadiness.wait(ptyId, afterGeneration ?? 0, timeoutMs, signal)
}

export function getSizeFromRuntimeController(ptyId: string) {
  return ptySizes.get(ptyId) ?? null
}

export async function serializeProviderBufferFromRuntimeController(
  ptyId: string,
  opts?: { scrollbackRows?: number }
) {
  try {
    // Unmounted restored daemon PTYs still need provider snapshots for phone navigation.
    return (await getProviderForPty(ptyId).getBufferSnapshot?.(ptyId, opts)) ?? null
  } catch {
    return null
  }
}
