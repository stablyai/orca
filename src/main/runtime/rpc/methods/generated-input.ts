import { defineMethod, defineStreamingMethod } from '../core'
import {
  DismissGeneratedInputNoticeParams,
  GeneratedInputNoticesPageParams,
  GeneratedInputNoticesUnsubscribeParams,
  TerminalSendGeneratedInputParams
} from '../../../../shared/rpc-contract/generated-input-params'
import { generatedInputNoticeFrames } from '../../../../shared/generated-agent-input-notice'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { deliverGeneratedTerminalInput } from '../../terminal/input/generated-terminal-input-delivery'
import { GeneratedInputParts } from './generated-input-parts'
import { captureGeneratedInputRecovery } from '../../generated-agent-input-notices'

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
        params.retainNotice
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
        captureGeneratedInputRecovery(runtime, handle, agent, staged.text, params.submit)(outcome)
      }
      return { delivery: { outcome, ...(noticeRetained ? { noticeRetained: true as const } : {}) } }
    }
  }),
  defineMethod({
    name: 'terminal.dismissGeneratedInputNotice',
    permission: 'workspace',
    params: DismissGeneratedInputNoticeParams,
    handler: async ({ id }, { runtime }) => {
      runtime.generatedInputNotices.dismiss(id)
      return { dismissed: true }
    }
  }),
  defineStreamingMethod({
    name: 'terminal.generatedInputNotices.subscribe',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime, connectionId }, emit) => {
      const notices = runtime.generatedInputNotices
      await new Promise<void>((resolve) => {
        // Listen before the client pages its snapshot, so no change between them is lost.
        const unsubscribe = notices.subscribe((change) => {
          if (change.kind === 'dismissed') {
            emit({
              type: 'dismissed',
              session: notices.session,
              revision: change.revision,
              id: change.id
            })
            return
          }
          for (const frame of generatedInputNoticeFrames(change.notice).frames) {
            emit({ type: 'notice', session: notices.session, revision: change.revision, frame })
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
        emit({
          type: 'ready',
          subscriptionId,
          session: notices.session,
          revision: notices.revision
        })
      })
    }
  }),
  // Snapshot pages are pulled one at a time: the client's next request is the backpressure.
  defineMethod({
    name: 'terminal.generatedInputNotices.page',
    permission: 'workspace',
    params: GeneratedInputNoticesPageParams,
    handler: async ({ cursor, offset }, { runtime }) =>
      runtime.generatedInputNotices.page(cursor, offset)
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
  })
]
