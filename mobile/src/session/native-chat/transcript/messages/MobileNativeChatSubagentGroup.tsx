import { useMemo } from 'react'
import { Text, View } from 'react-native'
import { Bot } from 'lucide-react-native'
import {
  formatSubagentTokens,
  nativeChatSubagentGroupHeader
} from '../../../../../../src/shared/native-chat/transcript/subagents/native-chat-subagent-group-header'
import { mobileNativeChatSubagentGroupSay } from './native-chat-subagent-group-copy'
import { mobileNativeChatSessionOptionSay } from '../../input/session-options/native-chat-session-option-copy'
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
import { formatNativeChatDuration } from '../../../../../../src/shared/native-chat/transcript/turns/native-chat-turn-status'
import { useNow } from '../../../../hooks/use-now'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import type { Translate } from '../../../../i18n/mobile-i18n'
import { spacing, typography } from '../../../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../../../theme/themed-styles'
import { useMobileColors } from '../../../../theme/use-mobile-color-scheme'
import { MobileNativeChatEventName, MobileNativeChatEventRow } from './MobileNativeChatEventRow'
import { scaledType } from './mobile-native-chat-message-styles'

/** What it is doing or said, then its role, where it runs and its tokens; null when it has none. */
function subagentDetails(
  agent: NativeChatSubagentEntry,
  t: Translate
): { text: string; facts: string } | null {
  const working = normalizeSubagentState(agent.state) === 'working'
  const text =
    (working ? subagentEntryDetail(agent) : subagentMessageText(agent.lastMessage ?? '')) ?? ''
  const facts = [
    subagentRoleLabel(agent.agentType),
    subagentEntryRunsOn(agent, mobileNativeChatSessionOptionSay(t)),
    typeof agent.tokens === 'number'
      ? mobileNativeChatSubagentGroupSay(t)('tokens', {
          value0: formatSubagentTokens(agent.tokens)
        })
      : null
  ]
    .filter(Boolean)
    .join(' · ')
  return text || facts ? { text, facts } : null
}

/** Leaf so the shared 1s clock re-renders only the digits, never the group. */
function Elapsed({
  startedAt,
  settledAt,
  counting
}: {
  startedAt: number
  settledAt: number | null
  counting: boolean
}): React.JSX.Element {
  const now = useNow(1_000, counting)
  const end = counting ? now : (settledAt ?? now)
  // Keep "3m 21s" together so the wrap point doesn't move as it ticks.
  return (
    <>{formatNativeChatDuration(Math.max(0, (end - startedAt) / 1000)).replace(/ /g, '\u00a0')}</>
  )
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
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const state = normalizeSubagentState(agent.state)
  const details = subagentDetails(agent, t)
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

/** A turn's subagents under one summary row, closed until the reader opens it; a lone subagent is its
 *  own row. Trust host-recorded child state: a parent turn ending does not prove its children stopped. */
export function MobileNativeChatSubagentGroup({
  block,
  fontScale
}: {
  block: NativeChatSubagentGroupBlock
  fontScale: number
}): React.JSX.Element | null {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const header = useMemo(
    () => nativeChatSubagentGroupHeader(block.agents, mobileNativeChatSubagentGroupSay(t)),
    [block.agents, t]
  )
  if (header.total === 0) {
    return null
  }
  const rows = (
    <View testID="subagent-group" style={styles.group}>
      {block.agents.map((agent) => (
        <SubagentRow key={agent.id} agent={agent} groupId={block.groupId} fontScale={fontScale} />
      ))}
    </View>
  )
  if (header.total === 1) {
    return rows
  }
  const { working, headline, verdict, alertState, alert, clockStartedAt } = header
  const summary = alert === null ? verdict : `${verdict} +${alert}`
  return (
    <MobileNativeChatEventRow
      testID="subagent-summary"
      icon={<Bot size={14} color={colors.textMuted} strokeWidth={2} />}
      badge={
        working ? 'running' : (alertState ?? header.verdictState) === 'failed' ? 'failed' : null
      }
      label={[headline, summary, header.tokens].filter(Boolean).join(', ')}
      disclosureKey={`subagent-roster:${block.groupId}`}
      fontScale={fontScale}
      wordsLines={0}
      details={rows}
    >
      <MobileNativeChatEventName>{headline}</MobileNativeChatEventName>
      {` · ${summary}`}
      {clockStartedAt !== null ? (
        <>
          {' · '}
          <Elapsed startedAt={clockStartedAt} settledAt={header.settledAt} counting={working} />
        </>
      ) : null}
      {header.tokens !== null ? ` · ${header.tokens}` : null}
    </MobileNativeChatEventRow>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  group: { gap: spacing.xs },
  text: { color: colors.textPrimary },
  facts: { color: colors.textMuted }
}))
