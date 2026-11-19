import { Pressable, ScrollView, Text, View } from 'react-native'
import { X } from 'lucide-react-native'
import type {
  AgentMapNode,
  AgentMapNodeViewState
} from '../../../../src/shared/agent-session-map/agent-session-map-model'
import { formatAgentMapDuration } from '../../../../src/shared/agent-session-map/agent-session-map-duration'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { colors, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'

/** The tap-to-inspect sheet for one node: provenance stats, tool calls with
 *  timings, turns, questions/approvals, and the files it touched. */
export function MobileAgentMapDetail(args: {
  node: AgentMapNode
  view: AgentMapNodeViewState
  onClose: () => void
}): React.JSX.Element {
  const { node, view, onClose } = args
  const t = useMobileTranslation()
  const durationMs = node.lastTs - node.firstTs

  return (
    <View style={styles.sheet}>
      <View style={styles.handle} />
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>
          {node.label}
        </Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {node.kind === 'main'
            ? t('session.agentMap.node.mainAgent', 'Main agent')
            : t('session.agentMap.node.subagent', 'Sub-agent')}
          {' · '}
          {t(`session.agentMap.status.${view.status}`, view.status)}
        </Text>
        <Pressable
          hitSlop={12}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={t('session.agentMap.detail.close', 'Close details')}
        >
          <X size={16} color={colors.textSecondary} />
        </Pressable>
      </View>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <View style={styles.statGrid}>
          <Stat
            label={t('session.agentMap.detail.duration', 'Duration')}
            value={formatAgentMapDuration(durationMs)}
          />
          <Stat
            label={t('session.agentMap.detail.tools', 'Tool calls')}
            value={`${view.toolCount}${view.failedToolCount > 0 ? ` (${view.failedToolCount}✗)` : ''}`}
          />
          <Stat
            label={t('session.agentMap.detail.prompts', 'Prompts')}
            value={`${view.promptCount}`}
          />
          <Stat
            label={t('session.agentMap.detail.files', 'Files touched')}
            value={`${node.filesTouched.length}`}
          />
        </View>
        {view.lastStatusText ? <Text style={styles.statusNote}>{view.lastStatusText}</Text> : null}
        {node.lastPromptText ? (
          <Section title={t('session.agentMap.detail.lastPrompt', 'Last prompt')}>
            <Text style={styles.bodyText}>{node.lastPromptText}</Text>
          </Section>
        ) : null}
        {node.requests.length > 0 ? (
          <Section
            title={t('session.agentMap.detail.requests', 'Questions & approvals ({{count}})', {
              count: node.requests.length
            })}
          >
            {node.requests.map((request) => (
              <Text key={`${request.kind}-${request.ts}`} style={styles.bodyText}>
                {request.kind === 'question' ? '?' : '✓'}{' '}
                {request.detail ??
                  (request.kind === 'question'
                    ? t('session.agentMap.detail.question', 'Question')
                    : t('session.agentMap.detail.approval', 'Approval'))}
                <Text
                  style={{
                    color:
                      request.resolution === 'pending'
                        ? colors.statusAmber
                        : request.resolution === 'resolved'
                          ? colors.statusGreen
                          : colors.textMuted
                  }}
                >
                  {' · '}
                  {t(
                    `session.agentMap.detail.resolution.${request.resolution}`,
                    request.resolution
                  )}
                </Text>
              </Text>
            ))}
          </Section>
        ) : null}
        {node.toolCalls.length > 0 ? (
          <Section
            title={t('session.agentMap.detail.toolCalls', 'Tool calls ({{count}})', {
              count: node.toolCalls.length
            })}
          >
            {node.toolCalls.map((call) => (
              <View key={call.callId} style={styles.toolRow}>
                <Text
                  style={{
                    color:
                      call.state === 'running'
                        ? colors.accentBlue
                        : call.state === 'completed'
                          ? colors.statusGreen
                          : colors.statusRed
                  }}
                >
                  {call.state === 'running' ? '●' : call.state === 'completed' ? '✓' : '✗'}
                </Text>
                <Text style={styles.toolName} numberOfLines={1}>
                  {call.name}
                </Text>
                {call.summary ? (
                  <Text style={styles.toolSummary} numberOfLines={1}>
                    {call.summary}
                  </Text>
                ) : null}
                <Text style={styles.toolDuration}>
                  {call.durationMs !== undefined ? formatAgentMapDuration(call.durationMs) : '…'}
                </Text>
              </View>
            ))}
          </Section>
        ) : null}
        {node.turns.length > 0 ? (
          <Section
            title={t('session.agentMap.detail.turns', 'Turns ({{count}})', {
              count: node.turns.length
            })}
          >
            {node.turns.map((turn) => (
              <View key={turn.turnId} style={styles.toolRow}>
                <Text style={styles.toolName}>
                  {t(`session.agentMap.detail.turnState.${turn.state}`, turn.state)}
                </Text>
                {turn.durationMs !== undefined ? (
                  <Text style={styles.toolDuration}>{formatAgentMapDuration(turn.durationMs)}</Text>
                ) : null}
              </View>
            ))}
          </Section>
        ) : null}
        {node.filesTouched.length > 0 ? (
          <Section
            title={t('session.agentMap.detail.filesTouched', 'Files touched ({{count}})', {
              count: node.filesTouched.length
            })}
          >
            {node.filesTouched.map((path) => (
              <Text key={path} style={styles.fileRow} numberOfLines={1}>
                {path}
              </Text>
            ))}
          </Section>
        ) : null}
      </ScrollView>
    </View>
  )
}

function Stat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <View style={styles.statCell}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  )
}

function Section({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: '75%',
    backgroundColor: colors.bgPanel,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.borderSubtle,
    marginTop: 8,
    marginBottom: 4
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  title: {
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: '600',
    flexShrink: 1
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 12,
    flexShrink: 1
  },
  scroll: { flex: 1 },
  content: { paddingBottom: 24, paddingHorizontal: 16, paddingTop: 12 },
  statGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8
  },
  statCell: {
    backgroundColor: colors.bgRaised,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    minWidth: 100
  },
  statLabel: { color: colors.textMuted, fontSize: 11 },
  statValue: { color: colors.textPrimary, fontSize: 13, fontWeight: '600' },
  statusNote: {
    backgroundColor: colors.bgRaised,
    borderRadius: 8,
    color: colors.textSecondary,
    fontSize: 12,
    marginTop: 10,
    paddingHorizontal: 10,
    paddingVertical: 8
  },
  section: { marginTop: 14 },
  sectionTitle: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    marginBottom: 6
  },
  bodyText: { color: colors.textPrimary, fontSize: 13 },
  toolRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
    marginBottom: 4
  },
  toolName: { color: colors.textPrimary, fontSize: 12, fontFamily: typographyMono, maxWidth: 90 },
  toolSummary: { color: colors.textMuted, fontSize: 12, flexShrink: 1 },
  toolDuration: { color: colors.textMuted, fontSize: 11, marginLeft: 'auto' },
  fileRow: { color: colors.textPrimary, fontSize: 12, fontFamily: typographyMono, marginBottom: 3 }
}))

// The mobile typography module exposes the mono family for file paths and tool names.
const typographyMono = typography.monoFamily
