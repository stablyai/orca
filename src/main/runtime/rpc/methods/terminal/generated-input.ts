import { defineMethod, defineStreamingMethod } from '../../core'
import {
  DismissGeneratedInputNoticeParams,
  GeneratedInputNoticesPageParams,
  GeneratedInputNoticesSubscribeParams,
  GeneratedInputNoticesUnsubscribeParams,
  TerminalSendGeneratedInputParams
} from '../../../../../shared/rpc-contract/generated-input-params'
import { generatedInputNoticeFrames } from '../../../../../shared/generated-agent-input-notice'
import type { GeneratedInputOutcome } from '../../../../../shared/generated-terminal-input'
import { isTuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent-config'
import { deliverGeneratedTerminalInput } from '../../../terminal/input/generated-terminal-input-delivery'
import { GeneratedInputParts } from './generated-input-parts'
import type { GeneratedAgentInputNotices } from '../../../generated-agent-input-notices'
import {
  GENERATED_INPUT_NOTICE_REGISTER_METHODS,
  generatedInputNoticeViewer
} from './generated-input-notice-register'

let noticeSubscriptionSeq = 0
const parts = new GeneratedInputParts()

export const GENERATED_INPUT_METHODS = [
  defineMethod({
    name: 'terminal.sendGeneratedInput',
    permission: 'workspace',
    params: TerminalSendGeneratedInputParams,
    handler: async (params, context) => {
      const { runtime, signal, connectionId } = context
      // Meant for another runtime of this host: refused before any part is staged, any target is
      // resolved or anything is written. It is never a missing target.
      if (
        typeof params.terminal === 'object' &&
        params.terminal.expectedRuntimeId !== runtime.getRuntimeId()
      ) {
        return { refused: 'runtime-changed' as const }
      }
      const terminal =
        typeof params.terminal === 'object' ? params.terminal.handle : params.terminal
      const binding = JSON.stringify([
        params.terminal,
        params.ptyId,
        params.submit,
        params.agent,
        params.intent,
        params.inputKind,
        params.requireConsumer,
        params.retainNotice,
        params.operationId,
        params.window
      ])
      const staged = parts.accept(connectionId ?? 'inproc', params, binding)
      if (staged.kind === 'pending') {
        return { part: 'accepted' as const }
      }
      const handle = terminal ?? runtime.resolveGeneratedInputTarget(params.ptyId!)
      if (!handle) {
        // Nothing was written: the window's own record may move to a fresh target.
        if (params.operationId) {
          runtime.generatedInputNotices.prove(params.operationId, 'not-sent', true)
        }
        return { delivery: { outcome: 'target-gone' as const } }
      }
      const agent = params.agent && isTuiAgent(params.agent) ? params.agent : null
      const notices = runtime.generatedInputNotices
      const viewer = generatedInputNoticeViewer(context, params.window)
      // A paired window's operation has no audience here until it fails or that window claims it.
      const local = !!context.noticeOrigin
      const fields = {
        text: staged.text,
        agent,
        ...(params.submit ? {} : { submitted: false }),
        handle,
        ptyId: runtime.getTerminalPtyIdForHandle(handle),
        worktreeId: runtime.getTerminalWorktreeIdForHandle(handle) ?? ''
      }
      // The operation is bound to its exact text and target before anything waits, so a recovery
      // registration or a discard of the same id meets this record, never a second one.
      const bound =
        params.retainNotice === true &&
        !!params.operationId &&
        notices.upsert({
          ...fields,
          id: params.operationId,
          origin: local ? viewer : null,
          initiator: viewer,
          pending: true,
          certainty: 'not-sent',
          ...(connectionId ? { connection: connectionId } : {})
        }).retained
      let outcome: GeneratedInputOutcome = 'unconfirmed'
      try {
        outcome = await deliverGeneratedTerminalInput(runtime, handle, {
          text: staged.text,
          submit: params.submit,
          agent,
          timeoutMs: Math.max(0, staged.deadline - Date.now()),
          ...(params.inputKind ? { inputKind: params.inputKind } : {}),
          ...(params.intent ? { intent: params.intent } : {}),
          ...(params.requireConsumer ? { requireConsumer: true } : {}),
          // Each frame's actual handoff to the terminal, after its final checks: from the first, it
          // may have been written; only a refusal before any taken frame proves it unsent.
          ...(bound
            ? { onGeneratedFrame: () => observeLocalFrame(notices, params.operationId!) }
            : {}),
          // A caller that went away no longer holds the text, so its queued write must not land later.
          ...(signal ? { signal } : {})
        })
      } finally {
        if (bound && (outcome === 'delivered' || outcome === 'staged')) {
          notices.settle(params.operationId!)
        } else if (bound) {
          notices.prove(
            params.operationId!,
            outcome === 'unconfirmed' ? 'unconfirmed' : 'not-sent',
            outcome === 'target-gone'
          )
          // Unclaimed by any window here, and kept by nobody: nothing outlives the operation.
          if (agent === null || outcome === 'target-gone') {
            notices.settle(params.operationId!, null)
          }
        }
      }
      // The failed text's notice belongs to this runtime session, not to the client that asked,
      // so a reloaded client re-reads it until it is dismissed.
      const noticeRetained =
        params.retainNotice === true &&
        agent !== null &&
        (outcome === 'not-sent' || outcome === 'unconfirmed')
      if (noticeRetained) {
        // The operation's own record: a recovery registration of the same id lands on it, and a
        // dismissal made before this completion keeps it discarded.
        const { retained } = notices.upsert({
          ...fields,
          ...(params.operationId ? { id: params.operationId } : {}),
          origin: null,
          proven: true,
          certainty: outcome === 'unconfirmed' ? 'unconfirmed' : 'not-sent'
        })
        if (!retained) {
          return { delivery: { outcome } }
        }
      }
      return { delivery: { outcome, ...(noticeRetained ? { noticeRetained: true as const } : {}) } }
    }
  }),
  defineMethod({
    name: 'terminal.dismissGeneratedInputNotice',
    permission: 'workspace',
    params: DismissGeneratedInputNoticeParams,
    handler: async ({ id, window, authorityRuntimeId, owner }, context) => {
      // A discard meant for an earlier runtime of this host never applies to this one.
      if (authorityRuntimeId && authorityRuntimeId !== context.runtime.getRuntimeId()) {
        return { dismissed: false, stale: true as const }
      }
      // Only this desktop's own window names the paired host whose notice it discards.
      const dismissed = context.runtime.generatedInputNotices.dismiss(
        id,
        generatedInputNoticeViewer(context, window),
        context.noticeOrigin && owner ? owner : undefined
      )
      return { dismissed }
    }
  }),
  defineStreamingMethod({
    name: 'terminal.generatedInputNotices.subscribe',
    permission: 'workspace',
    params: GeneratedInputNoticesSubscribeParams,
    handler: async (params, context, emit) => {
      const { runtime, connectionId } = context
      const notices = runtime.generatedInputNotices
      const viewer = generatedInputNoticeViewer(context, params?.window)
      // This window's renderer was replaced mid-request: its pending requests become notices.
      if (viewer) {
        notices.revealPending(viewer, connectionId)
      }
      // Revisions count what this subscriber may see, so a gap still means a lost message and
      // another window's private change never looks like one.
      let sent = notices.revision
      await new Promise<void>((resolve) => {
        // Listen before the client pages its snapshot, so no change between them is lost.
        // Another window's private notice is filtered here, before any frame is built.
        const unsubscribe = notices.subscribe((change) => {
          if (change.origin !== null && change.origin !== viewer) {
            return
          }
          sent += 1
          if (change.kind === 'dismissed') {
            emit({ type: 'dismissed', session: notices.session, revision: sent, id: change.id })
            return
          }
          for (const frame of generatedInputNoticeFrames(change.notice).frames) {
            emit({ type: 'notice', session: notices.session, revision: sent, frame })
          }
        })
        const subscriptionId = `generated-input-notices-${connectionId ?? 'inproc'}-${++noticeSubscriptionSeq}`
        runtime.registerSubscriptionCleanup(
          subscriptionId,
          () => {
            unsubscribe()
            emit({ type: 'end' })
            resolve()
          },
          connectionId
        )
        emit({ type: 'ready', subscriptionId, session: notices.session, revision: sent })
      })
    }
  }),
  // Snapshot pages are pulled one at a time: the client's next request is the backpressure.
  defineMethod({
    name: 'terminal.generatedInputNotices.page',
    permission: 'workspace',
    params: GeneratedInputNoticesPageParams,
    handler: async ({ cursor, offset, window }, context) =>
      context.runtime.generatedInputNotices.page(
        cursor,
        offset,
        generatedInputNoticeViewer(context, window)
      )
  }),
  defineMethod({
    name: 'terminal.generatedInputNotices.unsubscribe',
    permission: 'workspace',
    params: GeneratedInputNoticesUnsubscribeParams,
    handler: async ({ subscriptionId }, { runtime, connectionId }) => {
      if (!subscriptionId.startsWith(`generated-input-notices-${connectionId ?? 'inproc'}-`)) {
        return { unsubscribed: false }
      }
      runtime.cleanupSubscription(subscriptionId)
      return { unsubscribed: true }
    }
  }),
  ...GENERATED_INPUT_NOTICE_REGISTER_METHODS
]

function observeLocalFrame(
  notices: GeneratedAgentInputNotices,
  id: string
): (taken: boolean | 'unknown') => void {
  notices.dispatched(id)
  return (taken) =>
    notices.frameSettled(id, taken === 'unknown' ? 'unknown' : taken ? 'accepted' : 'refused')
}
