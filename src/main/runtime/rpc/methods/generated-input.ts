import { defineMethod, defineStreamingMethod } from '../core'
import {
  DismissGeneratedInputNoticeParams,
  GeneratedInputNoticesPageParams,
  GeneratedInputNoticesUnsubscribeParams,
  TerminalSendGeneratedInputParams
} from '../../../../shared/rpc-contract/generated-input-params'
import { generatedInputNoticeFrames } from '../../../../shared/generated-agent-input-notice'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import { deliverGeneratedTerminalInput } from '../../terminal/input/generated-terminal-input-delivery'
import { GeneratedInputParts } from './generated-input-parts'
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
    handler: async (params, { runtime, signal, connectionId }) => {
      const binding = JSON.stringify([
        params.terminal,
        params.ptyId,
        params.submit,
        params.agent,
        params.intent,
        params.inputKind,
        params.requireConsumer,
        params.retainNotice,
        params.operationId
      ])
      const staged = parts.accept(connectionId ?? 'inproc', params, binding)
      if (staged.kind === 'pending') {
        return { part: 'accepted' as const }
      }
      const handle = params.terminal ?? runtime.resolveGeneratedInputTarget(params.ptyId!)
      if (!handle) {
        return { delivery: { outcome: 'target-gone' as const } }
      }
      const agent = params.agent && isTuiAgent(params.agent) ? params.agent : null
      const outcome = await deliverGeneratedTerminalInput(runtime, handle, {
        text: staged.text,
        submit: params.submit,
        agent,
        timeoutMs: Math.max(0, staged.deadline - Date.now()),
        ...(params.inputKind ? { inputKind: params.inputKind } : {}),
        ...(params.intent ? { intent: params.intent } : {}),
        ...(params.requireConsumer ? { requireConsumer: true } : {}),
        // A caller that went away no longer holds the text, so its queued write must not land later.
        ...(signal ? { signal } : {})
      })
      // The failed text's notice belongs to this runtime session, not to the client that asked,
      // so a reloaded client re-reads it until it is dismissed.
      const noticeRetained =
        params.retainNotice === true &&
        agent !== null &&
        (outcome === 'not-sent' || outcome === 'unconfirmed')
      if (noticeRetained) {
        // The operation's own record: a recovery registration of the same id lands on it, and a
        // dismissal made before this completion keeps it discarded.
        const { retained } = runtime.generatedInputNotices.upsert({
          ...(params.operationId ? { id: params.operationId } : {}),
          origin: null,
          proven: true,
          text: staged.text,
          agent,
          certainty: outcome,
          ...(params.submit ? {} : { submitted: false }),
          handle,
          ptyId: runtime.getTerminalPtyIdForHandle(handle),
          worktreeId: runtime.getTerminalWorktreeIdForHandle(handle) ?? ''
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
    handler: async ({ id }, context) => {
      context.runtime.generatedInputNotices.dismiss(id, generatedInputNoticeViewer(context))
      return { dismissed: true }
    }
  }),
  defineStreamingMethod({
    name: 'terminal.generatedInputNotices.subscribe',
    permission: 'workspace',
    params: null,
    handler: async (_params, context, emit) => {
      const { runtime, connectionId } = context
      const notices = runtime.generatedInputNotices
      const viewer = generatedInputNoticeViewer(context)
      // This window's renderer was replaced mid-request: its pending requests become notices.
      if (context.noticeOrigin) {
        notices.revealPending(context.noticeOrigin, connectionId)
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
    handler: async ({ cursor, offset }, context) =>
      context.runtime.generatedInputNotices.page(
        cursor,
        offset,
        generatedInputNoticeViewer(context)
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
