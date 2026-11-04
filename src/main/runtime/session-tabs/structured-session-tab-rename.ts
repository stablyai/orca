import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../shared/runtime-session-contracts'

export type SessionTabProps = {
  tabId: string
  color?: string | null
  isPinned?: boolean
  viewMode?: 'terminal' | 'chat'
  customTitle?: string | null
}

export async function renameStructuredSessionTab<Props extends { customTitle?: string | null }>(
  snapshot: RuntimeMobileSessionTabsSnapshot | undefined,
  tabId: string,
  props: Props,
  installHost: () => Promise<void>
): Promise<Props> {
  const tab = snapshot?.tabs.find(
    (candidate) => candidate.id === tabId && candidate.type === 'agent-session'
  )
  if (props.customTitle === undefined || tab?.type !== 'agent-session') {
    return props
  }
  await installHost()
  const result = await getStructuredAgentSessionHost()?.setUserConversationName(
    tab.sessionId,
    props.customTitle ?? '',
    'rename'
  )
  if (!result?.applied) {
    throw new Error('agent_session_rename_failed')
  }
  return { ...props, customTitle: undefined }
}
