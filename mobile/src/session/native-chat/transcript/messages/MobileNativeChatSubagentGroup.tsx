import { Text, View } from 'react-native'
import { Bot } from 'lucide-react-native'
import { formatSubagentTokens } from '../../../../../../src/shared/native-chat/transcript/subagents/native-chat-subagent-group-header'
import { sayMobileNativeChatSubagentGroup as say } from './native-chat-subagent-group-copy'
import { sayMobileNativeChatSessionOption as sayOption } from '../../input/session-options/native-chat-session-option-copy'
import { normalizeSubagentState } from '../../../../../../src/shared/native-chat/transcript/subagents/native-chat-subagent-summary'
import {
  subagentEntryDetail,
  subagentEntryRunsOn,
  subagentMessageText,
  subagentRoleLabel
} from '../../../../../../src/shared/native-chat/transcript/subagents/native-chat-subagent-entry-detail'
import type {
  NativeChatSubagentEntry,
  NativeChatSubagentGroupBlock
} from '../../../../../../src/shared/native-chat/native-chat-types'
import { colors, spacing, typography } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../../theme/use-mobile-color-scheme'
import { MobileNativeChatEventName, MobileNativeChatEventRow } from './MobileNativeChatEventRow'
import { scaledType } from './mobile-native-chat-message-styles'

/** What it is doing or said, then its role, where it runs and its tokens; null when it has none. */
function subagentDetails(agent: NativeChatSubagentEntry): { text: string; facts: string } | null {
  const working = normalizeSubagentState(agent.state) === 'working'
  const text =
    (working ? subagentEntryDetail(agent) : subagentMessageText(agent.lastMessage ?? '')) ?? ''
  const facts = [
    subagentRoleLabel(agent.agentType),
    subagentEntryRunsOn(agent, sayOption),
    typeof agent.tokens === 'number'
      ? say('tokens', { value0: formatSubagentTokens(agent.tokens) })
      : null
  ]
    .filter(Boolean)
    .join(' · ')
  return text || facts ? { text, facts } : null
}

/** One subagent as a status row: the agent mark with a spinner while it works and a red ✕ when it
 *  failed, then its name. Opens to what it is doing or its result. */
function SubagentRow({
  agent,
  groupId,
  fontScale
}: {
  agent: NativeChatSubagentEntry
  groupId: string
  fontScale: number
}): React.JSX.Element {
  const state = normalizeSubagentState(agent.state)
  const details = subagentDetails(agent)
  const type = scaledType(typography.bodySize, fontScale)
  return (
    <MobileNativeChatEventRow
      testID="subagent-row"
      icon={<Bot size={14} color={colors.textMuted} strokeWidth={2} />}
      badge={state === 'working' ? 'running' : state === 'failed' ? 'failed' : null}
      label={agent.label}
      timestamp={agent.startedAt ?? null}
      disclosureKey={`subagent:${groupId}:${agent.id}`}
      fontScale={fontScale}
      details={
        details ? (
          <>
            {details.text ? (
              <Text selectable style={[styles.text, type]}>
                {details.text}
              </Text>
            ) : null}
            {details.facts ? (
              <Text style={[styles.facts, scaledType(typography.metaSize, fontScale, 4)]}>
                {details.facts}
              </Text>
            ) : null}
          </>
        ) : null
      }
    >
      <MobileNativeChatEventName>{agent.label}</MobileNativeChatEventName>
    </MobileNativeChatEventRow>
  )
}

/** A turn's subagents, one row each. Trust host-recorded child state: a parent turn ending does not
 *  prove its children stopped. */
export function MobileNativeChatSubagentGroup({
  block,
  fontScale
}: {
  block: NativeChatSubagentGroupBlock
  fontScale: number
}): React.JSX.Element | null {
  useMobileColorScheme()
  if (block.agents.length === 0) {
    return null
  }
  return (
    <View testID="subagent-group" style={styles.group}>
      {block.agents.map((agent) => (
        <SubagentRow key={agent.id} agent={agent} groupId={block.groupId} fontScale={fontScale} />
      ))}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  group: { gap: spacing.xs },
  text: { color: colors.textPrimary },
  facts: { color: colors.textMuted }
}))
