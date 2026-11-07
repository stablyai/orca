import { defineMethod, InvalidArgumentError, type RpcContext } from '../../core'
import { RegisterGeneratedInputNoticeParams } from '../../../../../shared/rpc-contract/generated-input-params'
import { isTuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent-config'
import { GeneratedInputParts } from './generated-input-parts'
import { completeNoticeOwner } from '../../../generated-agent-input-notice-commands'
import { GENERATED_INPUT_REGISTER_RUNTIME_CAPABILITY } from '../../../../../shared/terminal/runtime-policy/terminal-runtime-capabilities'

const parts = new GeneratedInputParts()

/** The logical window a private notice belongs to, stable across a renderer reload and never the
 *  replaceable socket: the local window the IPC transport proved, or a paired desktop's window
 *  under that pairing's authenticated device. Null (shared notices only) for a client that cannot
 *  be told apart from others, or that does not read private notices and unknown agents at all. */
export function generatedInputNoticeViewer(
  context: RpcContext,
  window?: string | null
): string | null {
  if (!context.clientCapabilities?.includes(GENERATED_INPUT_REGISTER_RUNTIME_CAPABILITY)) {
    return null
  }
  if (context.noticeOrigin) {
    return context.noticeOrigin
  }
  if (context.pairedDeviceId && window) {
    return `device:${context.pairedDeviceId}/window:${window}`
  }
  return null
}

export const GENERATED_INPUT_NOTICE_REGISTER_METHODS = [
  // Registers one operation's failure notice for the caller's window, or settles its pending
  // record. It never writes to a terminal; registering again is harmless (one record per id).
  defineMethod({
    name: 'terminal.generatedInputNotices.register',
    permission: 'workspace',
    params: RegisterGeneratedInputNoticeParams,
    handler: async (params, context) => {
      const origin = generatedInputNoticeViewer(context, params.window)
      // Without a window identity a private notice would have no audience but everyone's.
      if (!origin) {
        return { retained: false }
      }
      // Meant for an earlier runtime of this host: refused before anything is staged or kept.
      if (
        params.authorityRuntimeId &&
        params.authorityRuntimeId !== context.runtime.getRuntimeId()
      ) {
        return { retained: false, stale: true as const }
      }
      const notices = context.runtime.generatedInputNotices
      const local = !!context.noticeOrigin
      // A control acts on a whole operation at once; split into parts it could mix two.
      if (params.part && (params.settle || params.observed || params.targetGone)) {
        throw new InvalidArgumentError('A notice control cannot arrive in parts')
      }
      if (params.settle) {
        // This desktop's window saw the host it sent to hold the operation: its copy gives way.
        const observed = local ? completeNoticeOwner(params.observed) : null
        if (observed) {
          notices.observeHost(params.id, origin, observed)
        } else {
          notices.settle(params.id, origin)
        }
        return { settled: true }
      }
      // This desktop's own client found the target gone before writing anything.
      if (local && params.targetGone) {
        notices.prove(params.id, 'not-sent', true)
      }
      // The whole obligation every part must name alike, so a final part can never switch the
      // target, intent, audience or host receipt the earlier parts were accepted under.
      const owner = local && params.owner ? params.owner : undefined
      const descriptor = {
        id: params.id,
        origin,
        agent: params.agent && isTuiAgent(params.agent) ? params.agent : null,
        certainty: params.certainty,
        submitted: params.submitted !== false,
        pending: params.pending === true,
        handle: params.handle ?? '',
        worktreeId: params.worktreeId ?? '',
        ptyId: params.ptyId ?? null,
        owner: owner
          ? {
              environmentId: owner.environmentId,
              window: owner.window,
              runtimeId: owner.runtimeId ?? null,
              pairingRevision: owner.pairingRevision ?? null
            }
          : null
      }
      const staged = parts.accept(
        context.connectionId ?? 'inproc',
        params,
        JSON.stringify(descriptor)
      )
      if (staged.kind === 'pending') {
        return { part: 'accepted' as const }
      }
      const { retained, conflict, discarded } = notices.upsert({
        id: descriptor.id,
        origin,
        text: staged.text,
        agent: descriptor.agent,
        certainty: descriptor.certainty,
        ...(descriptor.submitted ? {} : { submitted: false }),
        handle: descriptor.handle,
        worktreeId: descriptor.worktreeId,
        ptyId: descriptor.ptyId,
        pending: descriptor.pending,
        ...(context.connectionId ? { connection: context.connectionId } : {}),
        // Owner metadata is this desktop's own; a paired caller's is never kept.
        ...(owner ? { owner } : {}),
        // This desktop's client reports the outcome it saw, applied before the notice is shown.
        ...(local && !descriptor.pending ? { reported: true } : {})
      })
      // A conflicting obligation under this id is refused explicitly; the caller keeps its own.
      if (conflict) {
        return { retained: false, conflict: true as const }
      }
      return discarded ? { retained: false, discarded: true as const } : { retained }
    }
  })
]
