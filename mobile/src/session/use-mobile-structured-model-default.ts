import type { AgentSessionOptionResult } from '../../../src/shared/agent-session/options/agent-session-options-result'
import { lockedStructuredAgentSessionOptionSnapshot } from '../../../src/shared/agent-session/options/structured-agent-session-option-snapshot'
import { useCallback, type RefObject } from 'react'
import { structuredAgentSessionDefaultModelChoice } from '../../../src/shared/structured-agent-session-default-model-choice'
import {
  beginStructuredOptionPick,
  settleStructuredOptionPick,
  structuredOptionPickCommit
} from '../../../src/shared/structured-agent-session-option-pick-book'
import type { RpcClient } from '../transport/rpc-client'

import type { SessionOptionDescriptor } from '../../../src/shared/native-chat/input/native-chat-session-options'
import {
  commitStructuredAgentSessionModelDefault,
  commitStructuredAgentSessionOptionValues,
  type StructuredAgentSessionOptionState
} from '../../../src/shared/agent-session/options/structured-agent-session-options'
import { structuredAgentSessionShownSnapshot } from '../../../src/shared/agent-session/options/structured-agent-session-option-view'
import type { StructuredAgentSessionMutate } from './mobile-structured-agent-session-rpc'
import type { useMobileStructuredOptionState } from './use-mobile-structured-option-state'
import { nativeChatSessionOptionsWrite } from './mobile-session-launch-operations'
import { isTuiAgent } from '../../../src/shared/tui-agent-config'

export const MOBILE_MODEL_DEFAULT_PICK = ''

export function mobileStructuredModelDefaultSnapshot(
  snapshot: SessionOptionDescriptor[],
  state: StructuredAgentSessionOptionState,
  supported: boolean,
  awaitingOptions: boolean
): SessionOptionDescriptor[] {
  const choices = supported
    ? snapshot.map((descriptor) =>
        descriptor.id === 'model'
          ? {
              ...descriptor,
              settable: true,
              defaultChoice: structuredAgentSessionDefaultModelChoice(state)
            }
          : descriptor
      )
    : snapshot
  return awaitingOptions ? lockedStructuredAgentSessionOptionSnapshot(choices) : choices
}

export function useMobileStructuredModelDefault(args: {
  agent: string | null
  client: RpcClient | null
  sessionId: string | null
  mutate: StructuredAgentSessionMutate
  takesModelDefault: boolean
  awaitingOptions: boolean
  lockSnapshotRef: RefObject<(snapshot: SessionOptionDescriptor[]) => SessionOptionDescriptor[]>
  source: Pick<
    ReturnType<typeof useMobileStructuredOptionState>,
    | 'optionStateRef'
    | 'activeOptionRecordRef'
    | 'controller'
    | 'optionPicks'
    | 'updateOptionState'
    | 'writes'
    | 'beginOptionWrite'
    | 'isCurrentContext'
  >
}) {
  const { agent, client, sessionId, mutate, takesModelDefault, awaitingOptions, lockSnapshotRef } =
    args
  const {
    optionStateRef,
    activeOptionRecordRef,
    optionPicks,
    controller,
    updateOptionState,
    writes,
    beginOptionWrite,
    isCurrentContext
  } = args.source
  return useCallback(
    async (id: string) => {
      const snapshot = () => ({
        snapshot: lockSnapshotRef.current(
          structuredAgentSessionShownSnapshot(optionStateRef.current)
        )
      })
      if (
        id !== 'model' ||
        takesModelDefault !== true ||
        !client ||
        !sessionId ||
        !agent ||
        awaitingOptions ||
        writes.current.count > 0 ||
        controller.pending().length > 0 ||
        !isCurrentContext()
      ) {
        return snapshot()
      }
      const targetRecord = optionStateRef.current.record
      const pick = beginStructuredOptionPick(
        optionPicks.current,
        id,
        MOBILE_MODEL_DEFAULT_PICK,
        false
      )
      const sameRecord = () => isCurrentContext() && activeOptionRecordRef.current === targetRecord
      const finish = beginOptionWrite(id)
      updateOptionState((state) => ({ ...state }))
      let readsBack = false
      try {
        const result = await mutate<AgentSessionOptionResult>(
          'agentSession.setOption',
          'agentSession.setOption',
          { key: id, value: null }
        )
        const committed =
          result.status === 'accepted' && result.sameFence && sameRecord()
            ? structuredOptionPickCommit(optionPicks.current, pick, result.value.options ?? {})
            : null
        if (result.status === 'accepted' && committed) {
          controller.abandon()
          controller.setModelDefault(result.value.modelDefault === true)
          updateOptionState((state) =>
            result.value.modelDefault
              ? commitStructuredAgentSessionModelDefault(state, committed)
              : {
                  ...commitStructuredAgentSessionOptionValues(state, committed, 'picked', id),
                  modelDefault: false
                }
          )
          if (result.value.modelDefault && isTuiAgent(agent)) {
            void nativeChatSessionOptionsWrite
              .request(client, { type: 'clear-model', agent })
              .catch(() => {})
          }
        }
        readsBack = result.status !== 'rejected'
        return snapshot()
      } finally {
        if (sameRecord()) {
          settleStructuredOptionPick(optionPicks.current, pick)
          updateOptionState((state) => ({ ...state }))
        }
        finish(readsBack)
      }
    },
    [
      activeOptionRecordRef,
      agent,
      awaitingOptions,
      client,
      takesModelDefault,
      isCurrentContext,
      lockSnapshotRef,
      mutate,
      optionStateRef,
      optionPicks,
      controller,
      beginOptionWrite,
      sessionId,
      updateOptionState,
      writes
    ]
  )
}
