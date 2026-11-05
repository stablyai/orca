import { useContext, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { Users } from 'lucide-react-native'
import type { OrchestrationCrewRow } from '../../../../../src/shared/orchestration-crew'
import { BottomDrawer } from '../../../components/bottom-drawer/BottomDrawer'
import { MobileAgentIcon } from '../../../components/MobileAgentIcon'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { colors, radii, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { MobileAgentMessageOpenContext } from '../transcript/mobile-agent-message-context'
import {
  crewOpenSender,
  crewRowSubtitle,
  mobileCrewRunningWorkers,
  mobileCrewStatus,
  mobileCrewVisible,
  type MobileCrewStatus
} from '../../orchestration-crew/mobile-orchestration-crew'
import { useMobileOrchestrationCrew } from '../../orchestration-crew/use-mobile-orchestration-crew'
import type { RpcClient } from '../../../transport/rpc-client'

export function MobileOrchestrationCrewBar({
  client,
  party,
  onMention
}: {
  client: RpcClient | null
  party: string | null
  onMention: (row: OrchestrationCrewRow) => void
}): React.JSX.Element | null {
  const snapshot = useMobileOrchestrationCrew(client, party)
  if (!mobileCrewVisible(snapshot)) {
    return null
  }
  return (
    <CrewBar
      manager={snapshot.sections.managedBy}
      workers={snapshot.sections.managing}
      peers={snapshot.sections.talkingWith}
      running={mobileCrewRunningWorkers(snapshot)}
      onMention={onMention}
    />
  )
}

function CrewBar({
  manager,
  workers,
  peers,
  running,
  onMention
}: {
  manager: readonly OrchestrationCrewRow[]
  workers: readonly OrchestrationCrewRow[]
  peers: readonly OrchestrationCrewRow[]
  running: number
  onMention: (row: OrchestrationCrewRow) => void
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [open, setOpen] = useState(false)
  const workerLabel =
    workers.length === 1
      ? t('chat.crew.worker', '{{count}} worker', { count: workers.length })
      : t('chat.crew.workers', '{{count}} workers', { count: workers.length })
  const runningLabel =
    running === 1
      ? t('chat.crew.runningOne', '{{count}} running', { count: running })
      : t('chat.crew.running', '{{count}} running', { count: running })
  const label =
    workers.length > 0
      ? running > 0
        ? t('chat.crew.workersRunning', '{{workers}} · {{running}}', {
            workers: workerLabel,
            running: runningLabel
          })
        : workerLabel
      : manager.length > 0
        ? manager.length === 1
          ? t('chat.crew.manager', '{{count}} manager', { count: manager.length })
          : t('chat.crew.managers', '{{count}} managers', { count: manager.length })
        : peers.length === 1
          ? t('chat.crew.peer', '{{count}} peer', { count: peers.length })
          : t('chat.crew.peers', '{{count}} peers', { count: peers.length })
  const sections = [
    ['manager', t('chat.crew.sectionManager', 'Manager'), manager],
    ['workers', t('chat.crew.sectionWorkers', 'Workers'), workers],
    ['peers', t('chat.crew.sectionPeers', 'Peers'), peers]
  ] as const
  return (
    <View style={styles.bar}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={t('chat.crew.open', 'Crew, {{label}}', { label })}
        testID="native-chat-crew-pill"
        onPress={() => setOpen(true)}
        style={styles.pill}
      >
        <Users size={14} color={colors.textSecondary} strokeWidth={2} />
        <Text style={styles.pillText}>{label}</Text>
        {running > 0 ? <View style={styles.dot} /> : null}
      </Pressable>
      <BottomDrawer visible={open} onClose={() => setOpen(false)} dragContentToDismiss>
        <View style={styles.sheet}>
          <Text style={styles.sheetTitle}>{t('chat.crew.title', 'Crew')}</Text>
          {sections.map(([key, title, rows]) =>
            rows.length === 0 ? null : (
              <View key={key} style={styles.group}>
                <Text style={styles.section}>{title}</Text>
                {rows.map((row, index) => (
                  <View key={row.partyKey}>
                    {index > 0 ? <View style={styles.separator} /> : null}
                    <CrewRow
                      row={row}
                      onOpen={() => setOpen(false)}
                      onMention={() => {
                        setOpen(false)
                        onMention(row)
                      }}
                    />
                  </View>
                ))}
              </View>
            )
          )}
        </View>
      </BottomDrawer>
    </View>
  )
}

function statusLabel(t: ReturnType<typeof useMobileTranslation>, status: MobileCrewStatus): string {
  switch (status) {
    case 'running':
      return t('chat.crew.status.running', 'Running')
    case 'waiting':
      return t('chat.crew.status.waiting', 'Waiting')
    case 'done':
      return t('chat.crew.status.done', 'Done')
    case 'failed':
      return t('chat.crew.status.failed', 'Failed')
  }
}

function CrewRow({
  row,
  onOpen,
  onMention
}: {
  row: OrchestrationCrewRow
  onOpen: () => void
  onMention: () => void
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const openSender = useContext(MobileAgentMessageOpenContext)
  const status = mobileCrewStatus(row)
  const title = row.task?.title || row.label
  const subtitle = crewRowSubtitle(row, title)
  const mentionable = Boolean(row.sendAddress)
  const open = () => {
    const target = crewOpenSender(row)
    if (target && openSender) {
      openSender(target.from, target.sender)
    }
    onOpen()
  }
  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('chat.crew.openAgent', 'Open {{name}}', { name: row.label })}
        testID="native-chat-crew-row"
        onPress={open}
        onLongPress={mentionable ? onMention : undefined}
        delayLongPress={350}
        style={styles.rowMain}
      >
        <MobileAgentIcon agentId={row.agentKind} size={20} />
        <View style={styles.rowText}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {title}
          </Text>
          {subtitle ? (
            <Text style={styles.rowMeta} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        <Text
          style={[
            styles.status,
            status === 'failed' && styles.statusFailed,
            status === 'waiting' && styles.statusWaiting
          ]}
        >
          {statusLabel(t, status)}
        </Text>
      </Pressable>
      {mentionable ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('chat.crew.mention', 'Mention {{name}}', { name: row.label })}
          testID="native-chat-crew-mention"
          hitSlop={8}
          onPress={onMention}
          onLongPress={onMention}
        >
          <Text style={styles.mention}>{t('chat.crew.mentionShort', 'Mention')}</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  bar: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xs
  },
  pill: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 28,
    paddingHorizontal: spacing.sm + 2,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.composerControl
  },
  pillText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: radii.pill,
    backgroundColor: colors.textPrimary
  },
  sheet: {
    gap: spacing.sm,
    paddingBottom: spacing.sm
  },
  sheetTitle: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  group: {
    borderRadius: radii.surface,
    backgroundColor: colors.sheetGroup,
    overflow: 'hidden'
  },
  section: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm
  },
  separator: {
    height: 1,
    marginLeft: spacing.md,
    backgroundColor: colors.borderSubtle
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 52,
    paddingRight: spacing.md
  },
  rowMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 52,
    paddingLeft: spacing.md,
    paddingVertical: spacing.sm
  },
  rowText: {
    flex: 1,
    minWidth: 0
  },
  rowTitle: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '500'
  },
  rowMeta: {
    color: colors.textMuted,
    fontSize: typography.metaSize
  },
  status: {
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  statusFailed: {
    color: colors.statusRed
  },
  statusWaiting: {
    color: colors.statusAmber
  },
  mention: {
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    fontWeight: '600'
  }
}))
