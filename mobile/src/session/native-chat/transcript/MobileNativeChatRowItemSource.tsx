import { memo, useContext, useMemo, type ComponentProps } from 'react'
import {
  MobileNativeChatItemSourceContext,
  MobileNativeChatRootItemSourceContext
} from '../../mobile-native-chat-item-read'
import { MobileNativeChatMessage } from './MobileNativeChatMessage'
import {
  resolveMobileNativeChatRowProps,
  type MobileNativeChatRowLookups
} from './use-mobile-native-chat-row-props'
import { equalMobileNativeChatRowContent } from './mobile-native-chat-row-projection'
import type { MobileNativeChatVisualSource } from '../visual/mobile-native-chat-visual-read'
import type { MobileNativeChatMessageDetail } from './use-mobile-native-chat-message-detail'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat-types'

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
  source: Recovery | null
}

// React's mounted content props are the sole reuse baseline.
export const MobileNativeChatRowContent = memo(function MobileNativeChatRowContent({
  source,
  scope: _scope,
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
  return (
    <MobileNativeChatItemSourceContext.Provider value={value}>
      <MobileNativeChatMessage {...props} />
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
  'scope' | 'fontScale' | 'onOpenFile' | 'structuredActivityUi' | 'onToggleTurn'
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
  return <MobileNativeChatRowContent {...props} {...outer} source={source} />
}
async function unavailable(): Promise<void> {
  throw new Error('Message unavailable')
}
