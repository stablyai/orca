import { InvalidArgumentError, defineMethod, type RpcAnyMethod } from '../../core'
import { isTerminalQueryReply } from '../../../../../shared/terminal-query-reply'
import { assertTerminalAgentSendable } from '../../terminal-agent-send-guard'
import { TerminalSend } from './unary-schemas'
import {
  assertTerminalSendExactPtyBinding,
  assertTerminalSendTextWithinLimit,
  commitMobileInputFloorClaim,
  getTerminalSendGuardRefusedReason,
  isTerminalInputLockedForClient,
  isTerminalSendGuardNotWritable,
  resolveMobileFloorClientId,
  type MobileInputFloorClaimHolder
} from './terminal-input-delivery'
import { updateViewportForClient } from './terminal-viewport-update'

export const TERMINAL_SEND_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: 'terminal.send',
    params: TerminalSend,
    handler: async (params, { runtime, clientId, signal }) => {
      await assertTerminalSendTextWithinLimit(params.text)
      await assertTerminalSendTextWithinLimit(params.resolvedLaunchDraft?.text)
      const queryReplyClientId = clientId ?? params.client?.id
      const quickCommandPrompt =
        params.quickCommand === true && params.text?.endsWith('\r')
          ? params.text.slice(0, -1)
          : null
      if (
        params.quickCommand === true &&
        (!quickCommandPrompt ||
          params.enter !== undefined ||
          params.interrupt !== undefined ||
          params.agentPrompt !== undefined ||
          params.resolvedLaunchDraft !== undefined ||
          params.requireAgentStatus !== undefined ||
          params.inputKind !== undefined ||
          params.client?.type !== 'desktop')
      ) {
        throw new InvalidArgumentError('Invalid terminal Quick Command')
      }
      if (
        params.inputKind === 'query-reply' &&
        (!params.text ||
          !isTerminalQueryReply(params.text) ||
          params.enter === true ||
          params.interrupt === true ||
          params.agentPrompt === true ||
          params.quickCommand === true ||
          params.requireAgentStatus !== undefined ||
          params.client?.type !== 'mobile' ||
          !queryReplyClientId ||
          (clientId !== undefined && params.client.id !== clientId))
      ) {
        throw new InvalidArgumentError('Invalid terminal query reply')
      }
      // Why: a stale handle must fail with terminal_handle_stale, not evaluate driver/lock state against the wrong PTY (#7718).
      const leaf = runtime.resolveLiveLeafForHandle(params.terminal)
      const driver = leaf?.ptyId ? runtime.getDriver(leaf.ptyId) : null
      if (
        params.inputKind === 'query-reply' &&
        leaf?.ptyId &&
        !runtime.isMobileTerminalQueryReplyAuthority(leaf.ptyId, queryReplyClientId!)
      ) {
        return {
          send: {
            handle: params.terminal,
            accepted: false,
            bytesWritten: 0
          }
        }
      }
      if (leaf?.ptyId && isTerminalInputLockedForClient(runtime, leaf.ptyId, params.client)) {
        return {
          send: {
            handle: params.terminal,
            accepted: false,
            bytesWritten: 0
          }
        }
      }
      if (
        leaf?.ptyId &&
        params.client?.type === 'desktop' &&
        params.claimViewport === true &&
        params.viewport
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
        // Why: a stream-less request can't safely create ownership, so never write at stale geometry.
        if (!claim.updated || isTerminalInputLockedForClient(runtime, leaf.ptyId, params.client)) {
          return {
            send: {
              handle: params.terminal,
              accepted: false,
              bytesWritten: 0
            }
          }
        }
      }
      const hasText = typeof params.text === 'string' && params.text.length > 0
      const hasSuffix = params.enter === true || params.interrupt === true
      if (params.requireAgentStatus === 'sendable' && hasText && hasSuffix) {
        // Why: guarded sends are two-phase; reject combined payload + submit so a guard flip can't cause partial delivery.
        return {
          send: {
            handle: params.terminal,
            accepted: false,
            bytesWritten: 0
          }
        }
      }
      // Why: recheck permission/no-agent state immediately before accepting the PTY write.
      const assertSendPreconditions =
        params.requireAgentStatus === 'sendable'
          ? async (ptyId?: string): Promise<void> => {
              await assertTerminalAgentSendable({
                runtime,
                handle: params.terminal,
                assertWritable: () => {
                  assertTerminalSendExactPtyBinding(runtime, params.terminal, ptyId)
                  if (ptyId && isTerminalInputLockedForClient(runtime, ptyId, params.client)) {
                    throw new Error('terminal_guard_not_writable')
                  }
                }
              })
            }
          : undefined
      if (params.requireAgentStatus === 'sendable') {
        try {
          await assertSendPreconditions?.(leaf?.ptyId ?? undefined)
        } catch (error) {
          if (isTerminalSendGuardNotWritable(error)) {
            return {
              send: {
                handle: params.terminal,
                accepted: false,
                bytesWritten: 0
              }
            }
          }
          const refusedReason = getTerminalSendGuardRefusedReason(error)
          if (!refusedReason) {
            throw error
          }
          return {
            send: {
              handle: params.terminal,
              accepted: false,
              bytesWritten: 0,
              refusedReason
            }
          }
        }
      }
      const mobileFloorClientId = resolveMobileFloorClientId(driver, params.client)
      const mobileFloorClaim: MobileInputFloorClaimHolder = { current: null }
      const isCliAgentPrompt =
        params.agentPrompt === true &&
        hasText &&
        params.enter === true &&
        params.interrupt !== true &&
        params.client?.type === 'desktop'
      const quickCommandBeforeWrite =
        (params.quickCommand === true || isCliAgentPrompt) && !assertSendPreconditions
          ? async (ptyId: string): Promise<void> => {
              assertTerminalSendExactPtyBinding(runtime, params.terminal, ptyId)
              if (isTerminalInputLockedForClient(runtime, ptyId, params.client)) {
                throw new Error('terminal_guard_not_writable')
              }
            }
          : undefined
      const beforeWrite = assertSendPreconditions ?? quickCommandBeforeWrite
      const settledAgentPrompt = quickCommandPrompt ?? (isCliAgentPrompt ? params.text! : null)
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
      let result
      try {
        const write = async () => {
          const useSettledAgentPrompt =
            settledAgentPrompt !== null &&
            (await runtime.isTerminalRunningSettledPromptAgent(params.terminal))
          return useSettledAgentPrompt
            ? runtime.sendTerminalAgentPrompt(params.terminal, settledAgentPrompt!, {
                beforeWrite,
                signal,
                preferProtocolSubmit: true
              })
            : runtime.sendTerminal(
                params.terminal,
                {
                  text: params.text,
                  enter: params.enter === true,
                  interrupt: params.interrupt === true
                },
                {
                  beforeWrite,
                  signal,
                  ...(reserveWrite ? { reserveWrite } : {}),
                  ...(params.inputKind !== 'query-reply' && mobileFloorClientId
                    ? { afterWrite: () => commitMobileInputFloorClaim(mobileFloorClaim) }
                    : {})
                }
              )
        }
        if (leaf?.ptyId && runtime.enqueueTerminalInputWrite) {
          const queued = runtime.enqueueTerminalInputWrite(
            leaf.ptyId,
            write,
            typeof params.text === 'string' ? Buffer.byteLength(params.text, 'utf8') : 0
          )
          result = queued ? await queued : await write()
        } else {
          result = await write()
        }
      } catch (error) {
        mobileFloorClaim.current?.rollback()
        const refusedReason = getTerminalSendGuardRefusedReason(error)
        if (refusedReason) {
          return {
            send: {
              handle: params.terminal,
              accepted: false,
              bytesWritten: 0,
              refusedReason
            }
          }
        }
        if (isTerminalSendGuardNotWritable(error)) {
          return {
            send: {
              handle: params.terminal,
              accepted: false,
              bytesWritten: 0
            }
          }
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
      // Why: deliberate mobile input takes the floor (drives `* → mobile{clientId}`); clientless sends fall back to the current mobile driver.
      return { send: result }
    }
  })
]
