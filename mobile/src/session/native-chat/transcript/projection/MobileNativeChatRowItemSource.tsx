import {
  sameNativeChatTurnDiff,
  type NativeChatTurnDiff
} from '../../../../../../src/shared/native-chat/tools/native-chat-turn-diffs'
import { MobileNativeChatTurnDiffRollup } from '../tool-results/MobileNativeChatTurnDiffRollup'
import { memo, useContext, useMemo, type ComponentProps } from 'react'
import { View } from 'react-native'
import {
  MobileNativeChatItemSourceContext,
  MobileNativeChatRootItemSourceContext
} from './mobile-native-chat-item-read'
import { MobileNativeChatMessage } from '../messages/MobileNativeChatMessage'
import { MobileNativeChatWorkerApprovalReceipts } from '../messages/MobileNativeChatWorkerApprovalReceipts'
import { mobileNativeChatActivityJoinMargins } from '../messages/mobile-native-chat-activity-join'
import { MobileNativeChatQuietTurnContext } from '../message-content/MobileNativeChatAnswerProse'
import type { NativeChatActivityJoin } from '../../../../../../src/shared/native-chat/transcript/events/native-chat-activity-rows'
import {
  resolveMobileNativeChatRowProps,
  type MobileNativeChatRowLookups
} from './use-mobile-native-chat-row-props'
import { equalMobileNativeChatRowContent } from './mobile-native-chat-row-projection'
import type { MobileNativeChatVisualSource } from '../../visual/mobile-native-chat-visual-read'
import type { MobileNativeChatMessageDetail } from './use-mobile-native-chat-message-detail'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'

type Recovery = MobileNativeChatVisualSource & {
  load: (id: string) => Promise<void>
  details: {
    id: string
    raw: NativeChatMessage | undefined
    state: ReturnType<MobileNativeChatMessageDetail['state']>
  }[]
}
export type MobileNativeChatRowContentProps = ComponentProps<typeof MobileNativeChatMessage> & {
  scope: string
  turnDiff?: NativeChatTurnDiff
  /** The sides where this activity row touches another. */
  activityJoin?: NativeChatActivityJoin
  inAutomationTurn?: true
  inActingTurn?: true
  source: Recovery | null
}

const TurnDiffOutcome = memo(
  MobileNativeChatTurnDiffRollup,
  (previous, next) =>
    sameNativeChatTurnDiff(previous.diff, next.diff) && previous.fontScale === next.fontScale
)

// React's mounted content props are the sole reuse baseline.
export const MobileNativeChatRowContent = memo(function MobileNativeChatRowContent({
  source,
  scope: _scope,
  turnDiff,
  activityJoin,
  inAutomationTurn,
  inActingTurn,
  ...props
}: MobileNativeChatRowContentProps) {
  const value = useMemo(() => {
    if (!source) {
      return null
    }
    const details = new Map(source.details.map((detail) => [detail.id, detail]))
    return {
      client: source.client,
      sessionId: source.sessionId,
      messageDetail: {
        raw: (id: string) => details.get(id)?.raw,
        state: (id: string) => details.get(id)?.state ?? null,
        load: source.load
      }
    }
  }, [source])
  const quietTurn = useMemo(
    () => ({ inAutomationTurn: inAutomationTurn === true, inActingTurn: inActingTurn === true }),
    [inAutomationTurn, inActingTurn]
  )
  return (
    <MobileNativeChatItemSourceContext.Provider value={value}>
      {/* Always this View, so a row a new one joins keeps its mounted content. */}
      <View style={mobileNativeChatActivityJoinMargins(activityJoin, props.message)}>
        <MobileNativeChatQuietTurnContext.Provider value={quietTurn}>
          <MobileNativeChatMessage {...props} />
        </MobileNativeChatQuietTurnContext.Provider>
      </View>
      {turnDiff ? <TurnDiffOutcome diff={turnDiff} fontScale={props.fontScale ?? 1} /> : null}
    </MobileNativeChatItemSourceContext.Provider>
  )
}, equalMobileNativeChatRowContent)

export function MobileNativeChatRow({
  message,
  index,
  lookups,
  ...outer
}: Pick<
  MobileNativeChatRowContentProps,
  'scope' | 'fontScale' | 'structuredActivityUi' | 'onToggleTurn'
> & { message: NativeChatMessage; index: number; lookups: MobileNativeChatRowLookups }) {
  const current = useContext(MobileNativeChatRootItemSourceContext)
  const props = resolveMobileNativeChatRowProps(index, message, lookups)
  const detail = current?.messageDetail
  const source: Recovery | null = current
    ? {
        client: current.client,
        sessionId: current.sessionId,
        load: detail?.load ?? unavailable,
        details: (props.workRun ?? [message]).map((member) => {
          const raw = detail?.raw(member.id)
          return {
            id: member.id,
            raw: raw?.shortened ? raw : undefined,
            state: detail?.state(member.id) ?? null
          }
        })
      }
    : null
  return (
    <>
      <MobileNativeChatRowContent {...props} {...outer} source={source} />
      <MobileNativeChatWorkerApprovalReceipts
        messageId={message.id}
        fontScale={outer.fontScale ?? 1}
      />
    </>
  )
}
async function unavailable(): Promise<void> {
  throw new Error('Message unavailable')
}
