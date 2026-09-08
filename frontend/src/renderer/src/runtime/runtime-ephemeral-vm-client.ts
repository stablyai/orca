// Why: mirrors runtime-workspace-cleanup-client.ts's hybrid-routing shape for
// the `ephemeralVm:*` preload methods that manage per-workspace VM/container
// recipes and runtimes. Local calls stay on window.api.ephemeralVm (real IPC,
// unchanged behavior); paired/web callers route through the `ephemeralVm.*`
// runtime RPC instead. `cancelProvision` is a normal request/response RPC
// (`ephemeralVm.cancelProvision`); `provision` is genuinely streaming (stdout/
// stderr chunks, then a terminal result/error) and routes through
// `subscribeRuntimeStreamChannel` (FE-TASK-EVM-002) instead of `callRuntimeRpc`
// — see FE-SOL-EVM-002 §2-3. `EPHEMERAL_VM_METHODS`'s "Why" comment in
// desktop/src/main/runtime/rpc/methods/ephemeral-vm.ts documents an unrelated
// mechanism (this desktop's own RPC server for OTHER clients pairing directly
// to it), not the web/paired path these functions cover.
import type { GlobalSettings, OrcaVmRecipeDiagnostic } from '../../../shared/types'
import {
  callRuntimeRpc,
  getActiveRuntimeTarget,
  subscribeRuntimeStreamChannel
} from './runtime-rpc-client'

type EphemeralVmSettings = Pick<GlobalSettings, 'activeRuntimeEnvironmentId'>

// FE-TASK-EVM-001 audit finding: backend-go's ephemeralVm.listRecipes/
// listRecipeCatalog send `diagnostics` as pre-formatted strings
// (ReadEphemeralVmRecipesResponse.diagnostics, backend-go/services/
// git-gateway-service/internal/usecase/read_ephemeral_vm_recipes.go's
// parseEnvironmentRecipes — e.g. "environmentRecipes[0]: id and create are
// required, skipping"), not the structured `{index, field?, message}` shape
// window.api.ephemeralVm's TS type (and desktop-local loadHooks()) declares.
// Left unnormalized, useComposerState.ts's diagnosticMessages formatter reads
// `diagnostic.index`/`.message` off a plain string and silently renders
// "environmentRecipes[undefined]: undefined", discarding the real message.
// Backend's strings already carry the "environmentRecipes[N]: " prefix, so
// extract N here instead of letting the formatter re-add it.
const RECIPE_DIAGNOSTIC_PREFIX = /^environmentRecipes\[(\d+)\]: ([\s\S]*)$/

function normalizeEphemeralVmDiagnostics(
  diagnostics: readonly unknown[]
): OrcaVmRecipeDiagnostic[] {
  return diagnostics.map((entry, fallbackIndex) => {
    if (typeof entry !== 'string') {
      return entry as OrcaVmRecipeDiagnostic
    }
    const match = RECIPE_DIAGNOSTIC_PREFIX.exec(entry)
    return match
      ? { index: Number(match[1]), message: match[2] }
      : { index: fallbackIndex, message: entry }
  })
}

export async function listRuntimeEphemeralVmRecipes(
  settings: EphemeralVmSettings | null | undefined,
  args: { repoId: string }
): ReturnType<typeof window.api.ephemeralVm.listRecipes> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind === 'local') {
    return window.api.ephemeralVm.listRecipes(args)
  }
  const result = await callRuntimeRpc<
    Awaited<ReturnType<typeof window.api.ephemeralVm.listRecipes>>
  >(target, 'ephemeralVm.listRecipes', args)
  // Audit finding: backend-go never returns this wrapper's `status`/`message`
  // fields at all (only repoPath/recipes/diagnostics) — the desktop-only
  // status:'error' variant (e.g. "recipes run on the local desktop host")
  // structurally cannot occur here; a resolved remote call is always success.
  return {
    ...result,
    status: 'ok',
    diagnostics: normalizeEphemeralVmDiagnostics(result.diagnostics)
  }
}

export async function listRuntimeEphemeralVmRecipeCatalog(
  settings: EphemeralVmSettings | null | undefined
): ReturnType<typeof window.api.ephemeralVm.listRecipeCatalog> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind === 'local') {
    return window.api.ephemeralVm.listRecipeCatalog()
  }
  const result = await callRuntimeRpc<
    Awaited<ReturnType<typeof window.api.ephemeralVm.listRecipeCatalog>>
  >(target, 'ephemeralVm.listRecipeCatalog')
  return result.map((entry) => ({
    ...entry,
    diagnostics: normalizeEphemeralVmDiagnostics(entry.diagnostics)
  }))
}

export function doctorRuntimeEphemeralVmRecipe(
  settings: EphemeralVmSettings | null | undefined,
  args: { repoId: string; recipeId: string }
): ReturnType<typeof window.api.ephemeralVm.doctor> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind === 'local') {
    return window.api.ephemeralVm.doctor(args)
  }
  return callRuntimeRpc(target, 'ephemeralVm.doctor', args)
}

export function listRuntimeEphemeralVmRuntimes(
  settings: EphemeralVmSettings | null | undefined
): ReturnType<typeof window.api.ephemeralVm.listRuntimes> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind === 'local') {
    return window.api.ephemeralVm.listRuntimes()
  }
  return callRuntimeRpc(target, 'ephemeralVm.listRuntimes')
}

export function attachRuntimeEphemeralVmWorkspace(
  settings: EphemeralVmSettings | null | undefined,
  args: { runtimeId: string; workspaceId: string }
): ReturnType<typeof window.api.ephemeralVm.attachWorkspace> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind === 'local') {
    return window.api.ephemeralVm.attachWorkspace(args)
  }
  return callRuntimeRpc(target, 'ephemeralVm.attachWorkspace', args)
}

export function suspendRuntimeEphemeralVmWorkspace(
  settings: EphemeralVmSettings | null | undefined,
  args: { workspaceId: string }
): ReturnType<typeof window.api.ephemeralVm.suspendWorkspace> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind === 'local') {
    return window.api.ephemeralVm.suspendWorkspace(args)
  }
  return callRuntimeRpc(target, 'ephemeralVm.suspendWorkspace', args)
}

export function resumeRuntimeEphemeralVmWorkspace(
  settings: EphemeralVmSettings | null | undefined,
  args: { workspaceId: string }
): ReturnType<typeof window.api.ephemeralVm.resumeWorkspace> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind === 'local') {
    return window.api.ephemeralVm.resumeWorkspace(args)
  }
  return callRuntimeRpc(target, 'ephemeralVm.resumeWorkspace', args)
}

export function cleanupRuntimeEphemeralVmWorkspace(
  settings: EphemeralVmSettings | null | undefined,
  args: { runtimeId: string }
): ReturnType<typeof window.api.ephemeralVm.cleanup> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind === 'local') {
    return window.api.ephemeralVm.cleanup(args)
  }
  return callRuntimeRpc(target, 'ephemeralVm.cleanup', args)
}

export function getRuntimeEphemeralVmCleanupCommand(
  settings: EphemeralVmSettings | null | undefined,
  args: { runtimeId: string }
): ReturnType<typeof window.api.ephemeralVm.getCleanupCommand> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind === 'local') {
    return window.api.ephemeralVm.getCleanupCommand(args)
  }
  return callRuntimeRpc(target, 'ephemeralVm.getCleanupCommand', args)
}

// FE-TASK-EVM-003 audit finding: window.api.ephemeralVm.provision's real args
// (api-types.ts:2520-2526) are repoId/recipeId/workspaceName?/projectId?/
// workspaceId?/provisionId? — a from-repo desktop provisioning flow. The
// planned backend-go `ephemeralVm.provision` StreamChannelHandler wire args
// (BE-SOL-EVM-002 §4/§6: `ephemeralVmProvisionArgs`) are instead
// connectionId/recipeId/runtimeId — provisioning against an already-resolved
// dev server connection for an existing runtime record. These are genuinely
// different flows, not a naming drift, so this type carries both branches'
// fields and each branch validates only the subset it needs at call time.
export type EphemeralVmProvisionArgs = {
  recipeId: string
  /** Local (desktop) branch — forwarded verbatim to window.api.ephemeralVm.provision. */
  repoId?: string
  workspaceName?: string
  projectId?: string
  workspaceId?: string
  provisionId?: string
  /** Environment (web/paired) branch — forwarded verbatim to backend-go's
   *  ephemeralVm.provision channel (BE-SOL-EVM-002 §4/§6). */
  connectionId?: string
  runtimeId?: string
}

type EphemeralVmLocalProvisionOutcome = Extract<
  Awaited<ReturnType<typeof window.api.ephemeralVm.provision>>,
  { ok: true }
>

// BE-SOL-EVM-002 §6's planned `VmProvisionResult` proto message, camelCased —
// backend-go has not shipped this channel yet (TASK-BE-EVM-005), so this shape
// is the documented wire contract, not something verified against a live
// server. Revisit once TASK-BE-EVM-005 ships if the real payload differs.
export type EphemeralVmChannelProvisionOutcome = {
  type: 'orca-server' | 'ssh'
  pairingCode?: string
  projectRoot?: string
  sshTarget?: unknown
}

// Mirrors BE-SOL-EVM-002 §6's planned VmProvisionEvent wire shape (type:
// stdout/stderr/result/error) so both branches funnel through the same
// onEvent contract, even though desktop's real transport (window.api's
// provision()/onProvisionEvent) has no native "result"/"error" event of its
// own — subscribeDesktopProvisionBroadcast synthesizes one below from
// provision()'s real resolved/rejected value.
export type EphemeralVmProvisionStreamEvent =
  | { type: 'stdout' | 'stderr'; chunk: string }
  | {
      type: 'result'
      result: EphemeralVmLocalProvisionOutcome | EphemeralVmChannelProvisionOutcome
    }
  | { type: 'error'; error: string }

export function provisionRuntimeEphemeralVmWorkspace(
  settings: EphemeralVmSettings | null | undefined,
  args: EphemeralVmProvisionArgs,
  onEvent: (event: EphemeralVmProvisionStreamEvent) => void
): Promise<{ ack: { provisionId: string }; unsubscribe: () => void }> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind === 'local') {
    return subscribeDesktopProvisionBroadcast(args, onEvent)
  }
  if (!args.connectionId || !args.runtimeId) {
    return Promise.reject(
      new Error(
        'provisionRuntimeEphemeralVmWorkspace: connectionId and runtimeId are required for environment targets'
      )
    )
  }
  return subscribeRuntimeStreamChannel<{ provisionId: string }, EphemeralVmProvisionStreamEvent>(
    target,
    'ephemeralVm.provision',
    { connectionId: args.connectionId, recipeId: args.recipeId, runtimeId: args.runtimeId },
    onEvent
  )
}

// Why: window.api.ephemeralVm.provision is request/response (resolves with
// the FULL final result) — desktop's real streaming signal is the separate
// global `onProvisionEvent` broadcast, filtered here by provisionId since the
// broadcast isn't scoped to one call. This adapter normalizes that into the
// same {ack, unsubscribe} + onEvent(stream) contract the environment branch
// gets natively from subscribeRuntimeStreamChannel — WITHOUT changing
// desktop's real IPC calls or behavior (FE-SOL-EVM-002 §3's "Không thuộc
// phạm vi": desktop path unchanged).
function subscribeDesktopProvisionBroadcast(
  args: EphemeralVmProvisionArgs,
  onEvent: (event: EphemeralVmProvisionStreamEvent) => void
): Promise<{ ack: { provisionId: string }; unsubscribe: () => void }> {
  if (!args.repoId) {
    return Promise.reject(
      new Error(
        'provisionRuntimeEphemeralVmWorkspace: repoId is required for local (desktop) targets'
      )
    )
  }
  const provisionId = args.provisionId ?? crypto.randomUUID()
  let stopped = false
  const unsubscribeBroadcast = window.api.ephemeralVm.onProvisionEvent((event) => {
    if (stopped || event.provisionId !== provisionId) {
      return
    }
    onEvent({ type: event.stream, chunk: event.chunk })
  })
  const unsubscribe = (): void => {
    if (stopped) {
      return
    }
    stopped = true
    unsubscribeBroadcast()
  }
  void window.api.ephemeralVm
    .provision({
      repoId: args.repoId,
      recipeId: args.recipeId,
      workspaceName: args.workspaceName,
      projectId: args.projectId,
      workspaceId: args.workspaceId,
      provisionId
    })
    .then((result) => {
      if (stopped) {
        return
      }
      if (result.ok) {
        onEvent({ type: 'result', result })
      } else {
        onEvent({ type: 'error', error: result.error })
      }
    })
    .catch((error: unknown) => {
      if (!stopped) {
        onEvent({ type: 'error', error: error instanceof Error ? error.message : String(error) })
      }
    })
    .finally(() => {
      unsubscribe()
    })
  return Promise.resolve({ ack: { provisionId }, unsubscribe })
}

export function cancelRuntimeEphemeralVmProvision(
  settings: EphemeralVmSettings | null | undefined,
  provisionId: string
): ReturnType<typeof window.api.ephemeralVm.cancelProvision> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind === 'local') {
    return window.api.ephemeralVm.cancelProvision({ provisionId })
  }
  return callRuntimeRpc(target, 'ephemeralVm.cancelProvision', { provisionId })
}
