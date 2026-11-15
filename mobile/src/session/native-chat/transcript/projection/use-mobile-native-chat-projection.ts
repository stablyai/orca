import { useMemo, useState } from 'react'
import type { AgentType } from '../../../../../../src/shared/agent-status/contracts/agent-status-types'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import { withoutPullRequestEventMessages } from '../../../../../../src/shared/native-chat/native-chat-pull-request-event'
import { projectMobileNativeChatMessages } from './mobile-native-chat-projection'

/** The rows the chat draws. CI result lines leave after projection, so a setting flip rebuilds nothing. */
export function useMobileNativeChatProjection(
  messages: readonly NativeChatMessage[],
  agent: AgentType,
  scope: readonly unknown[],
  showsCiResultLines: boolean
): NativeChatMessage[] {
  const rows = useProjectedRows(messages, agent, scope)
  return useMemo(
    () => (showsCiResultLines ? rows : withoutPullRequestEventMessages(rows)),
    [rows, showsCiResultLines]
  )
}

function useProjectedRows(
  messages: readonly NativeChatMessage[],
  agent: AgentType,
  scope: readonly unknown[]
): NativeChatMessage[] {
  const [state, setState] = useState(() => ({
    scope,
    projection: projectMobileNativeChatMessages(messages, agent)
  }))
  const sameScope =
    scope.length === state.scope.length &&
    scope.every((part, index) => Object.is(part, state.scope[index]))
  if (sameScope && state.projection.input === messages && state.projection.agent === agent) {
    return state.projection.rows
  }
  const projection = projectMobileNativeChatMessages(
    messages,
    agent,
    sameScope ? state.projection : undefined
  )
  setState({ scope, projection })
  return projection.rows
}
