import { isTerminalInputPaused, TerminalInputPausedError } from '../../../terminal-input-admission'
import { assertLegacyAiVaultResumeCommandAllowed } from '../../../../ai-vault/structured-session-ownership'
import { InvalidArgumentError, defineMethod } from '../../core'
import { isTerminalQueryReply } from '../../../../../shared/terminal-query-reply'
import { isUntypedTerminalInput } from '../../../../../shared/terminal-untyped-input'
import { assertTerminalAgentSendable } from '../../terminal-agent-send-guard'
import { TerminalSend } from '../../../../../shared/rpc-contract/terminal-unary-params'
import {
  assertTerminalSendExactPtyBinding,
  assertTerminalSendTextWithinLimit,
  commitMobileInputFloorClaim,
  getTerminalSendGuardRefusedReason,
  terminalInputSourceForClient,
  isTerminalSendGuardNotWritable,
  resolveMobileFloorClientId,
  type MobileInputFloorClaimHolder
} from './terminal-input-delivery'
import { updateViewportForClient } from './terminal-viewport-update'
import {
  ensureUnsupportedTerminalPromptReceipt,
  observeReplayedTerminalPrompt
} from './terminal-prompt-receipt'
import { observeQuestionAnswerSend } from './terminal-send-question-answered'

// Every refused send reports the same zero-byte result, with the guard's reason when it has one.
function refusedSend(
  handle: string,
  refusedReason?: NonNullable<ReturnType<typeof getTerminalSendGuardRefusedReason>>
) {
  return {
    send: { handle, accepted: false, bytesWritten: 0, ...(refusedReason ? { refusedReason } : {}) }
  }
}

export const TERMINAL_SEND_METHODS = [
  defineMethod({
    name: 'terminal.send',
    permission: 'workspace',
    params: TerminalSend,
    handler: async (
      params,
      {
        runtime,
        caller,
        clientId,
        signal,
        orchestrationMutation,
        recordMutationReceipt,
        markMutationEffectPossible,
        replayedMutationReceipt
      }
    ) => {
      const inputSource = terminalInputSourceForClient(params.client, caller)
      await assertTerminalSendTextWithinLimit(params.text)
      await assertTerminalSendTextWithinLimit(params.resolvedLaunchDraft?.text)
      if (params.text) {
        await assertLegacyAiVaultResumeCommandAllowed(params.text, () =>
          runtime.ensureStructuredAgentSessionHost()
        )
      }
      if (params.resolvedLaunchDraft?.text) {
        await assertLegacyAiVaultResumeCommandAllowed(params.resolvedLaunchDraft.text, () =>
          runtime.ensureStructuredAgentSessionHost()
        )
      }
      const queryReplyClientId = clientId ?? params.client?.id
      if (
        params.inputKind === 'query-reply' &&
        (!params.text ||
          !isTerminalQueryReply(params.text) ||
          params.enter === true ||
          params.interrupt === true ||
          params.agentPrompt === true ||
          params.requireAgentStatus !== undefined ||
          params.client?.type !== 'mobile' ||
          !queryReplyClientId ||
          (clientId !== undefined && params.client.id !== clientId))
      ) {
        throw new InvalidArgumentError('Invalid terminal query reply')
      }
      const replayObservation = await observeReplayedTerminalPrompt(
        runtime,
        params.terminal,
        replayedMutationReceipt,
        params.waitSubmitMs,
        signal
      )
      if (replayObservation) {
        return replayObservation
      }
      // Reject stale handles before evaluating driver/lock state on the wrong PTY (#7718).
      const leaf = runtime.resolveLiveLeafForHandle(params.terminal)
      const driver = leaf?.ptyId ? runtime.getDriver(leaf.ptyId) : null
      if (
        params.inputKind === 'query-reply' &&
        leaf?.ptyId &&
        (!runtime.isMobileTerminalQueryReplyAuthority(leaf.ptyId, queryReplyClientId!) ||
          !runtime.shouldForwardTerminalQueryReply(leaf.ptyId, params.text!))
      ) {
        return refusedSend(params.terminal)
      }
      if (leaf?.ptyId && isTerminalInputPaused(runtime, leaf.ptyId, inputSource)) {
        return refusedSend(params.terminal)
      }
      if (
        leaf?.ptyId &&
        inputSource === 'desktop' &&
        params.client?.type === 'desktop' &&
        params.claimViewport === true &&
        params.viewport &&
        // Only deliberate input may claim viewport ownership; focus/query sends otherwise trigger resize wars (#26469).
        !(
          typeof params.text === 'string' &&
          isUntypedTerminalInput(params.text) &&
          params.enter !== true &&
          params.interrupt !== true
        )
      ) {
        const claim = await updateViewportForClient(
          runtime,
          leaf.ptyId,
          `send:${params.client.id}`,
          params.client,
          params.viewport,
          'desktop',
          'refresh',
          true
        )
        // Without a stream, sends cannot safely claim ownership; refuse stale geometry.
        if (!claim.updated || isTerminalInputPaused(runtime, leaf.ptyId, inputSource)) {
          return refusedSend(params.terminal)
        }
      }
      const hasText = typeof params.text === 'string' && params.text.length > 0
      const hasSuffix = params.enter === true || params.interrupt === true
      if (params.requireAgentStatus === 'sendable' && hasText && hasSuffix) {
        // Guarded sends are two-phase; combined payload/submit could partially deliver across a guard flip.
        return refusedSend(params.terminal)
      }
      // Recheck permission and agent presence immediately before PTY acceptance.
      const assertSendPreconditions =
        params.requireAgentStatus === 'sendable'
          ? async (ptyId?: string): Promise<void> => {
              await assertTerminalAgentSendable({
                runtime,
                handle: params.terminal,
                assertWritable: () => {
                  assertTerminalSendExactPtyBinding(runtime, params.terminal, ptyId)
                }
              })
            }
          : undefined
      if (params.requireAgentStatus === 'sendable') {
        try {
          await assertSendPreconditions?.(leaf?.ptyId ?? undefined)
        } catch (error) {
          if (isTerminalSendGuardNotWritable(error)) {
            return refusedSend(params.terminal)
          }
          const refusedReason = getTerminalSendGuardRefusedReason(error)
          if (!refusedReason) {
            throw error
          }
          return refusedSend(params.terminal, refusedReason)
        }
      }
      const mobileFloorClientId = resolveMobileFloorClientId(driver, params.client)
      const mobileFloorClaim: MobileInputFloorClaimHolder = { current: null }
      const beforeWrite =
        orchestrationMutation && params.agentPrompt === true
          ? async (ptyId?: string): Promise<void> => {
              await assertSendPreconditions?.(ptyId)
              markMutationEffectPossible?.()
            }
          : assertSendPreconditions
      const useSettledAgentPrompt =
        params.agentPrompt === true &&
        hasText &&
        params.enter === true &&
        params.interrupt !== true &&
        params.client?.type === 'desktop' &&
        (await runtime.isTerminalRunningSettledPromptAgent(params.terminal))
      const reserveWrite =
        params.inputKind !== 'query-reply' && leaf?.ptyId && mobileFloorClientId
          ? (ptyId: string): void => {
              const claim = runtime.beginMobileInputFloor(ptyId, mobileFloorClientId)
              if (!claim) {
                throw new Error('mobile_input_floor_unavailable')
              }
              mobileFloorClaim.current = claim
            }
          : undefined
      const answered = observeQuestionAnswerSend(params, runtime)
      let result
      let acceptedPromptCheckpoint: unknown
      try {
        result = useSettledAgentPrompt
          ? await runtime.sendTerminalAgentPrompt(params.terminal, params.text!, {
              inputKind: 'driving',
              inputSource,
              beforeWrite,
              observationSignal: signal,
              ...(orchestrationMutation
                ? {
                    acceptQueued: true,
                    observationTimeoutMs: params.waitSubmitMs ?? 0,
                    requestId: orchestrationMutation.requestId,
                    onInputAccepted: (send) => {
                      acceptedPromptCheckpoint = { send }
                      recordMutationReceipt?.(acceptedPromptCheckpoint)
                    }
                  }
                : {})
            })
          : await runtime.sendTerminal(
              params.terminal,
              {
                text: params.text,
                enter: params.enter === true,
                interrupt: params.interrupt === true
              },
              {
                beforeWrite,
                inputSource,
                signal,
                // Why: a wire write carries no provenance beyond a client's own query reply.
                inputKind: params.inputKind === 'query-reply' ? 'query-reply' : 'driving',
                ...(params.requireWriteSettlement ? { requireWriteSettlement: true as const } : {}),
                ...(reserveWrite ? { reserveWrite } : {}),
                ...(params.inputKind !== 'query-reply' && mobileFloorClientId
                  ? { afterWrite: () => commitMobileInputFloorClaim(mobileFloorClaim) }
                  : {})
              }
            )
      } catch (error) {
        mobileFloorClaim.current?.rollback()
        if (acceptedPromptCheckpoint) {
          return acceptedPromptCheckpoint
        }
        const refusedReason = getTerminalSendGuardRefusedReason(error)
        if (refusedReason) {
          return refusedSend(params.terminal, refusedReason)
        }
        if (error instanceof TerminalInputPausedError || isTerminalSendGuardNotWritable(error)) {
          return refusedSend(params.terminal)
        }
        throw error
      }
      if (result.accepted !== true) {
        mobileFloorClaim.current?.rollback()
      }
      if (
        result.accepted === true &&
        params.enter === true &&
        params.client?.type === 'mobile' &&
        params.resolvedLaunchDraft
      ) {
        runtime.notifyNativeChatLaunchDraftResolved(params.terminal, params.resolvedLaunchDraft)
      }
      if (orchestrationMutation && params.agentPrompt === true && !result.prompt) {
        result = ensureUnsupportedTerminalPromptReceipt(
          runtime,
          params.terminal,
          orchestrationMutation.requestId,
          result
        )
      }
      // Deliberate mobile input claims its driver floor; clientless sends use the current mobile driver.
      return { send: answered(result) }
    }
  })
]
