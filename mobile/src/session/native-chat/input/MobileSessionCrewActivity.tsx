import { lazy, Suspense } from 'react'
import type { OrchestrationCrewRow } from '../../../../../src/shared/orchestration-crew'
import { resolveMobileNativeChatSessionId } from '../mobile-native-chat-eligibility'
import {
  appendCrewMention,
  mobileCrewParty,
  mobileCrewVisible
} from '../../orchestration-crew/mobile-orchestration-crew'
import { useMobileOrchestrationCrew } from '../../orchestration-crew/use-mobile-orchestration-crew'
import type { MobileSessionTab } from '../../mobile-session-route-types'
import type { RpcClient } from '../../../transport/rpc-client'

// Load the sheet only when a pill is shown. It pulls Reanimated, which chat tests do not mock.
const MobileOrchestrationCrewBar = lazy(() =>
  import('./MobileOrchestrationCrewBar').then((mod) => ({
    default: mod.MobileOrchestrationCrewBar
  }))
)

/** Crew pill for the current chat or terminal agent. Null when this host has no relations. */
export function MobileSessionCrewActivity({
  client,
  tab,
  setComposerText
}: {
  client: RpcClient | null
  tab: MobileSessionTab | null
  setComposerText: (update: (draft: string) => string) => void
}): React.JSX.Element | null {
  const party = mobileCrewParty({
    type: tab?.type ?? '',
    sessionId: resolveMobileNativeChatSessionId(tab),
    terminal: tab?.type === 'terminal' ? tab.terminal : null
  })
  const onMention = (row: OrchestrationCrewRow): void =>
    setComposerText((draft) => appendCrewMention(draft, row))
  const snapshot = useMobileOrchestrationCrew(client, party)
  if (!mobileCrewVisible(snapshot)) {
    return null
  }
  return (
    <Suspense fallback={null}>
      <MobileOrchestrationCrewBar client={client} party={party} onMention={onMention} />
    </Suspense>
  )
}
