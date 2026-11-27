// A coordinator chat's workers above the composer: one line ("3 workers · 1 needs you") that opens
// a sheet of their rows, as the Chats tab lists a chat's workers. Approvals stay in their own card.
import { memo, useContext, useMemo, useRef, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ChevronRight } from 'lucide-react-native'
import {
  compareWorkerDockEntries,
  type WorkerDockEntry
} from '../../../../../../src/shared/orchestration/dock/worker-dock'
import type { BotChatTreeWorker } from '../../../../../../src/shared/bots/bot-chat-tree'
import type { Translate } from '../../../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { AgentStateDot } from '../../../../agents/presentation/AgentStateDot'
import type { AgentDotState } from '../../../../worktree/agent-lineage/agent-row-display'
import { BottomDrawer } from '../../../../components/bottom-drawer/BottomDrawer'
import { SheetHeader } from '../../../../components/nav-bar/SheetHeader'
import { LIST_LEADING_INSET, ListGroup } from '../../../../components/list/ListGroup'
import { MobileBotWorkerRow } from '../../../../bots/MobileBotWorkerRow'
import { spacing, typography } from '../../../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../../../theme/themed-styles'
import { useMobileColors } from '../../../../theme/use-mobile-color-scheme'
import { MobileAgentMessageOpenContext } from '../../transcript/agent-messages/mobile-agent-message-context'
import { dispatchOpener } from '../prompts/MobileNativeChatWorkerApproval'
import type { MobileWorkerApproval } from '../prompts/use-mobile-worker-approvals'
import { trayStripStylesSheet } from './mobile-native-chat-tray-strip-styles'

type DockRow = WorkerDockEntry & { question?: string }

const NO_BOT = { id: '', name: '' }

function stateLabel(t: Translate, state: WorkerDockEntry['state']): string | undefined {
  switch (state) {
    case 'waiting':
    case 'coordinator':
      return t('components.native-chat.workerDock.coordinator', 'Waiting on coordinator')
    case 'starting':
      return t('components.native-chat.workerDock.starting', 'Starting')
    case 'idle':
      return t('components.native-chat.workerDock.idle', 'Idle')
    case 'saving':
      return t('components.native-chat.workerDock.saving', 'Saving result…')
    case 'failed':
      return t('components.native-chat.workerDock.failed', 'Failed')
    case 'unexpected':
      return t('components.native-chat.workerDock.unexpected', 'Stopped unexpectedly')
    case 'stopping':
      return t('components.native-chat.workerDock.stopping', 'Stopping…')
    default:
      return undefined
  }
}

/** "3 workers · 1 needs you", in the desktop dock's words. */
function summary(t: Translate, rows: readonly DockRow[]): string {
  const workers = rows.filter((row) => row.kind === 'worker').length
  const count = workers
    ? t('components.native-chat.workerDock.workerCount', '{{count}} workers', {
        count: workers,
        defaultValue_one: '{{count}} worker'
      })
    : t('components.native-chat.workerDock.taskCount', '{{count}} tasks', {
        count: rows.length,
        defaultValue_one: '{{count}} task'
      })
  const failed = rows.filter((row) => row.state === 'failed' || row.state === 'unexpected').length
  const needsYou = rows.filter((row) => row.state === 'needs-you').length
  const running = rows.filter((row) =>
    ['running', 'starting', 'stopping'].includes(row.state)
  ).length
  // What needs a person leads; running counts only when nothing does and some aren't.
  const status = [
    needsYou
      ? t('components.native-chat.workerDock.needsYouCount', '{{count}} needs you', {
          count: needsYou
        })
      : '',
    failed
      ? t('components.native-chat.workerDock.failedCount', '{{count}} failed', { count: failed })
      : '',
    !needsYou && !failed && running < rows.length && running
      ? t('components.native-chat.workerDock.runningCount', '{{count}} running', {
          count: running
        })
      : ''
  ]
  return [count, ...status].filter(Boolean).join(' · ')
}

function dotState(state: WorkerDockEntry['state']): AgentDotState {
  switch (state) {
    case 'needs-you':
      return 'permission'
    case 'failed':
    case 'unexpected':
      return 'failed'
    case 'unavailable':
      return 'unverifiable'
    case 'idle':
      return 'done'
    case 'waiting':
    case 'coordinator':
      return 'idle'
    default:
      return 'working'
  }
}

/** The Chats tab's worker row for a dock entry, so a worker reads the same in both places. */
function treeWorker(row: DockRow): BotChatTreeWorker {
  const settled = row.state === 'failed' || row.state === 'unexpected' || row.state === 'idle'
  return {
    key: row.id,
    title: row.title || row.name,
    state:
      row.state === 'needs-you'
        ? 'needs-you'
        : row.state === 'failed' || row.state === 'unexpected'
          ? 'failed'
          : row.state === 'unavailable'
            ? 'unreachable'
            : row.state === 'idle'
              ? 'done'
              : 'running',
    startedAt: row.startedAt ?? row.changedAt ?? Date.now(),
    ...(settled && row.changedAt !== null ? { settledAt: row.changedAt } : {})
  }
}

function MobileNativeChatWorkerDockImpl({
  rows,
  approvals
}: {
  rows: readonly WorkerDockEntry[]
  /** Open worker approvals: their workers read as waiting on you, and the card answers them. */
  approvals: readonly MobileWorkerApproval[]
}): React.JSX.Element | null {
  const strip = useThemedStyles(trayStripStylesSheet)
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const openSender = useContext(MobileAgentMessageOpenContext)
  const [open, setOpen] = useState(false)
  // The worker opens once the sheet is gone, as the tabs sheet's new tab does.
  const afterClose = useRef<(() => void) | null>(null)
  const asking = useMemo(
    () => new Map(approvals.map((entry) => [entry.approval.worker.dispatchId, entry])),
    [approvals]
  )
  const shown = useMemo(
    () =>
      rows
        .map((row): DockRow => {
          // As the desktop's: a settled or stopping worker never reads as waiting on you.
          const settled =
            row.state === 'failed' ||
            row.state === 'saving' ||
            (row.state === 'unexpected' && Boolean(row.settlement))
          const prompt =
            settled || row.state === 'stopping' ? undefined : asking.get(row.dispatchId)
          return prompt
            ? {
                ...row,
                state: 'needs-you',
                changedAt: Date.parse(prompt.askedAt ?? prompt.at),
                question: prompt.approval.summary.title
              }
            : row
        })
        .sort(compareWorkerDockEntries),
    [rows, asking]
  )
  // The last worker leaving closes the sheet, so new workers never reopen it on their own.
  if (open && shown.length === 0) {
    setOpen(false)
  }
  const close = () => setOpen(false)
  // Mounted while the strip is empty, so a sheet closing as its last worker leaves still opens the one tapped.
  const sheet = (
    <BottomDrawer
      visible={open}
      onClose={close}
      onAfterClose={() => {
        const next = afterClose.current
        afterClose.current = null
        next?.()
      }}
    >
      <SheetHeader
        title={t('components.native-chat.workerDock.workersRegion', 'Workers')}
        onClose={close}
      />
      <View style={styles.body}>
        <ListGroup separatorInset={LIST_LEADING_INSET}>
          {shown.map((row) => {
            // Its approval waits in the card above the message box, which answers it.
            const openWorker =
              row.question === undefined
                ? dispatchOpener(openSender, row.dispatchId, row.name)
                : null
            const reason = row.state === 'failed' || row.state === 'unexpected' ? row.reason : null
            return (
              <MobileBotWorkerRow
                key={row.id}
                bot={NO_BOT}
                worker={treeWorker(row)}
                nested={false}
                subtitle={row.question ?? reason ?? stateLabel(t, row.state)}
                onOpen={() => {
                  afterClose.current = openWorker
                  close()
                }}
              />
            )
          })}
        </ListGroup>
        <Text style={styles.footer}>
          {t(
            'components.native-chat.workerDock.stopOnComputer',
            'Stop or clear workers on the computer they run on'
          )}
        </Text>
      </View>
    </BottomDrawer>
  )
  const line = shown.length > 0 ? summary(t, shown) : null
  return (
    <>
      {line === null ? null : (
        <View style={strip.list} testID="worker-dock-strip">
          <View style={strip.box}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={line}
              hitSlop={spacing.xs}
              style={({ pressed }) => [strip.header, pressed && strip.pressed]}
              onPress={() => setOpen(true)}
            >
              <AgentStateDot state={dotState(shown[0].state)} decorative />
              <Text style={styles.line} numberOfLines={1} ellipsizeMode="tail">
                {line}
              </Text>
              <ChevronRight size={14} color={colors.textMuted} strokeWidth={2} />
            </Pressable>
          </View>
        </View>
      )}
      {sheet}
    </>
  )
}

export const MobileNativeChatWorkerDock = memo(MobileNativeChatWorkerDockImpl)

const stylesSheet = themedStyleSheet((colors) => ({
  line: {
    flex: 1,
    minWidth: 0,
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    fontWeight: '500'
  },
  body: { paddingBottom: spacing.lg },
  footer: {
    fontSize: 12,
    color: colors.textMuted,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm
  }
}))
