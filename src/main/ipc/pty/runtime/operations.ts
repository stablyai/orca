import type { IPtyProvider } from '../../../providers/types'
import { LocalPtyProvider } from '../../../providers/local-pty-provider'
import { parseAppSshPtyId } from '../../../providers/ssh-pty-id'
import { ptyOwnership } from '../provider/ownership-state'
import { ptySizes } from '../delivery/visibility-state'
import { rendererSerializerReadiness } from '../pane/serializer-state'
import { getProviderForPty, localProvider } from '../provider/registry'
import { inspectPtyProviderProcess } from '../../../providers/pty-process-inspection'
import type { PtyRuntimeControllerDeps } from './controller-deps'
import { agentSessionPtyWriteGate } from '../../../runtime/agent-session-pty-write-gate'
import { reportAgentSessionWriteRefusal } from '../agent-session-write-refusal-report'

export function writePtyFromRuntimeController(
  deps: PtyRuntimeControllerDeps,
  ptyId: string,
  data: string
): boolean {
  // Why: the backstop for every runtime write path — query replies, followups, deliveries —
  // so a caller that forgets the typed gate still cannot reach a provider.
  const admission = agentSessionPtyWriteGate.admit(ptyId)
  if (!admission.admitted) {
    reportAgentSessionWriteRefusal(deps.mainWindow, ptyId, admission.refusal)
    return false
  }
  try {
    return getProviderForPty(ptyId).write(ptyId, data) !== false
  } catch {
    return false
  }
}

export function writePtyAgentSessionProofFromRuntimeController(
  ptyId: string,
  data: string,
  authority: { sessionId: string; spawnToken: string }
): boolean {
  if (!agentSessionPtyWriteGate.admitProof(ptyId, authority)) {
    return false
  }
  try {
    return getProviderForPty(ptyId).write(ptyId, data) !== false
  } catch {
    return false
  }
}

export async function probePtyLivenessFromRuntimeController(
  deps: PtyRuntimeControllerDeps,
  ptyId: string
): Promise<boolean | null> {
  try {
    // Why: no locally routed provider can authoritatively answer for a
    // remote host's PTY, so remote-scoped ids stay unknown, never absent.
    if (ptyId.startsWith('remote:')) {
      return null
    }
    const connectionId = ptyOwnership.get(ptyId) ?? parseAppSshPtyId(ptyId)?.connectionId
    // Why: during cold start the daemon swap is in flight; the pre-swap
    // fallback would answer absent for every daemon-owned id.
    const startupPromise = deps.getLocalPtyProviderStartupPromise(connectionId)
    if (startupPromise) {
      await startupPromise
    }
    const provider = getProviderForPty(ptyId)
    if (provider.probePtyLiveness) {
      return await provider.probePtyLiveness(ptyId)
    }
    // Why: the in-process provider is its own sole owner (#12393), so its
    // refusal is authoritative; every other probe-less provider is doubt.
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
  if (ptyOwnership.get(ptyId) != null || parseAppSshPtyId(ptyId)) {
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
    // Why: cached foreground evidence cannot resolve a fresh shell conflict.
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
  // Why: desktop xterm and daemon/SSH providers hold separate buffers; clear both so mobile resubscribe can't resurrect cleared history.
  deps.mainWindow.webContents.send('pty:clearBuffer:request', { ptyId })
  try {
    await getProviderForPty(ptyId).clearBuffer(ptyId)
  } catch {
    /* best effort: renderer clear still handles local PTYs */
  }
}

const settledLocalPtyProviderStartups = new WeakSet<Promise<void>>()
const watchedLocalPtyProviderStartups = new WeakSet<Promise<void>>()

export function hasPtyFromRuntimeController(
  deps: PtyRuntimeControllerDeps,
  ptyId: string
): boolean | null {
  try {
    // Why: no locally routed provider can authoritatively answer for a
    // remote host's PTY, so remote-scoped ids stay unknown, never absent.
    if (ptyId.startsWith('remote:')) {
      return null
    }
    const connectionId = ptyOwnership.get(ptyId) ?? parseAppSshPtyId(ptyId)?.connectionId
    const startupPromise = deps.getLocalPtyProviderStartupPromise(connectionId)
    if (startupPromise && !settledLocalPtyProviderStartups.has(startupPromise)) {
      // Why: a sync probe cannot wait out the cold-start daemon swap the way
      // probePtyLiveness does, and the pre-swap provider's "no PTY" for a
      // daemon-restored id is fabricated — answer unverifiable until the swap
      // settles (docs/reference/ssh-execution-boundary.md rule 2).
      if (!watchedLocalPtyProviderStartups.has(startupPromise)) {
        watchedLocalPtyProviderStartups.add(startupPromise)
        const markSettled = (): void => {
          settledLocalPtyProviderStartups.add(startupPromise)
        }
        startupPromise.then(markSettled, markSettled)
      }
      return null
    }
    return getProviderForPty(ptyId).hasPty?.(ptyId) ?? null
  } catch {
    return null
  }
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
  // Why: a synchronous probe lets the runtime decide whether to skip the daemon-snapshot seed (renderer will hydrate) or run it (no renderer authoritative).
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
    // Why: restored daemon PTYs can be live while their desktop pane is unmounted; query the provider model so phone-local navigation works.
    return (await getProviderForPty(ptyId).getBufferSnapshot?.(ptyId, opts)) ?? null
  } catch {
    return null
  }
}
