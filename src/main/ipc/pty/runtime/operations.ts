import type { IPtyProvider } from '../../../providers/types'
import { LocalPtyProvider } from '../../../providers/local-pty-provider'
import type { PtyProcessInfo } from '../../../providers/pty-process-info'
import { parseAppSshPtyId } from '../../../providers/ssh-pty-id'
import {
  LOCAL_EXECUTION_HOST_ID,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { ptyOwnership } from '../provider/ownership-state'
import { ptySizes } from '../delivery/visibility-state'
import { rendererSerializerReadiness } from '../pane/serializer-state'
import {
  getProvider,
  getProviderForPty,
  localProvider,
  registeredPtyProviders
} from '../provider/registry'
import { inspectPtyProviderProcess } from '../../../providers/pty-process-inspection'
import type { PtyRuntimeControllerDeps } from './controller-deps'

export function writePtyFromRuntimeController(ptyId: string, data: string): boolean {
  try {
    getProviderForPty(ptyId).write(ptyId, data)
    return true
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

export async function inspectProcessFromRuntimeController(ptyId: string) {
  return inspectPtyProviderProcess(getProviderForPty(ptyId), ptyId)
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

export function hasPtyFromRuntimeController(ptyId: string): boolean | null {
  try {
    return getProviderForPty(ptyId).hasPty?.(ptyId) ?? null
  } catch {
    return null
  }
}

function markSshInventoryUnverifiable(
  runtime: PtyRuntimeControllerDeps['runtime'],
  connectionId: string,
  error: unknown
): void {
  const reason = error instanceof Error ? error.message : String(error)
  for (const [ptyId, ownerConnectionId] of ptyOwnership) {
    if (ownerConnectionId === connectionId) {
      runtime?.markPtyLivenessUnverifiable?.(ptyId, reason)
    }
  }
}

export async function listProcessesWithHostScopeFromRuntimeController(
  deps: PtyRuntimeControllerDeps,
  opts?: { deadlineMs?: number }
): Promise<{ processes: PtyProcessInfo[]; hostIds: ExecutionHostId[] }> {
  const providerSessions = await Promise.all(
    registeredPtyProviders().map(async ({ provider, connectionId }) => {
      const hostId: ExecutionHostId = connectionId
        ? toSshExecutionHostId(connectionId)
        : LOCAL_EXECUTION_HOST_ID
      try {
        return {
          processes: await (connectionId ? provider.listProcesses(opts) : provider.listProcesses()),
          hostId
        }
      } catch (error) {
        if (!connectionId) {
          throw error
        }
        markSshInventoryUnverifiable(deps.runtime, connectionId, error)
        return null
      }
    })
  )
  const respondingSessions = providerSessions.filter((session) => session !== null)
  return {
    processes: respondingSessions.flatMap((session) => session.processes),
    hostIds: respondingSessions.map((session) => session.hostId)
  }
}

export async function listProcessesFromRuntimeController(
  deps: PtyRuntimeControllerDeps,
  connectionId?: string | null,
  opts?: { deadlineMs?: number }
) {
  if (connectionId === null) {
    return localProvider.listProcesses()
  }
  if (connectionId !== undefined) {
    try {
      return await getProvider(connectionId).listProcesses(opts)
    } catch (error) {
      markSshInventoryUnverifiable(deps.runtime, connectionId, error)
      throw error
    }
  }
  return (await listProcessesWithHostScopeFromRuntimeController(deps, opts)).processes
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
  opts?: { scrollbackRows?: number; altScreenForcesZeroRows?: boolean }
) {
  try {
    // Why: restored daemon PTYs can be live while their desktop pane is unmounted; query the provider model so phone-local navigation works.
    return (await getProviderForPty(ptyId).getBufferSnapshot?.(ptyId, opts)) ?? null
  } catch {
    return null
  }
}
