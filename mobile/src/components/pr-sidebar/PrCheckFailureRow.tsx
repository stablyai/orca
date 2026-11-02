import { useRef, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import {
  Copy,
  CircleX,
  ExternalLink,
  MoreHorizontal,
  RotateCw,
  Sparkles,
  SquareTerminal
} from 'lucide-react-native'
import { colors, pressedStyle, radii, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { Translate } from '../../i18n/mobile-i18n'
import { openExternalLink } from '../../platform/external-link'
import { useClipboardWriter } from '../../platform/clipboard'
import { triggerError, triggerSuccess } from '../../platform/haptics'
import type { PRCheckDetail } from '../../../../src/shared/github/check-types'
import { LIST_LEADING_SLOT, LIST_ROW_PADDING } from '../list/ListGroup'
import { PullDownMenu } from '../nav-bar/PullDownMenu'
import type { ActionSheetAction } from '../ActionSheetModal'
import { PRCheckDetailView, type DetailEntry } from './PRCheckDetail'
import { PrMiniButton } from './PrMiniButton'
import { presentCheckDetail } from './pr-check-detail-content'

// A failing check shows its error under its name and offers the two actions that settle it; the rest sit in ⋯.
export function PrCheckFailureRow({
  check,
  entry,
  initiallyOpen,
  onOpen,
  actionable,
  fixLabel,
  onFix,
  fixBusy,
  fixAvailable,
  onRerun,
  rerunBusy
}: {
  check: PRCheckDetail
  entry: DetailEntry | undefined
  initiallyOpen: boolean
  onOpen: () => void
  actionable: boolean
  fixLabel: string
  onFix: () => void
  fixBusy: boolean
  fixAvailable: boolean
  onRerun: () => void
  rerunBusy: boolean
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const clipboard = useClipboardWriter()
  const [open, setOpen] = useState(initiallyOpen)
  const [showLog, setShowLog] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const menuRef = useRef<View>(null)
  const details = entry?.status === 'loaded' ? entry.details : null
  const content = details ? presentCheckDetail(details) : null
  const annotation = content?.annotations[0] ?? null
  const fallbackLine = content?.jobs[0]?.failedSteps[0]?.name ?? content?.summaryLines[1] ?? null
  const errorText = annotation
    ? [annotation.locator, annotation.title, annotation.message].filter(Boolean).join('\n')
    : fallbackLine
  const duration = details ? checkDuration(details.startedAt, details.completedAt, t) : null
  const menuGroups: ActionSheetAction[][] = [
    [
      {
        label:
          open && showLog
            ? t('pullRequest.screens.hideLog', 'Hide log')
            : t('pullRequest.screens.viewLog', 'View log'),
        icon: SquareTerminal,
        onPress: () => {
          if (open && showLog) {
            setShowLog(false)
            return
          }
          onOpen()
          setOpen(true)
          setShowLog(true)
        }
      },
      ...(errorText
        ? [
            {
              label: t('pullRequest.screens.copyError', 'Copy error'),
              icon: Copy,
              onPress: () => {
                setCopyFailed(false)
                void clipboard.writeText(errorText).then(triggerSuccess, () => {
                  triggerError()
                  setOpen(true)
                  setCopyFailed(true)
                })
              }
            }
          ]
        : []),
      ...(check.url
        ? [
            {
              label: t('pullRequest.screens.openOnGitHub', 'Open on GitHub'),
              icon: ExternalLink,
              onPress: () => check.url && openExternalLink(check.url)
            }
          ]
        : [])
    ]
  ]
  return (
    <View style={styles.row}>
      <View style={styles.head}>
        <Pressable
          style={({ pressed }) => [styles.headMain, pressed && pressedStyle]}
          onPress={() => {
            if (!open) {
              onOpen()
            }
            setOpen((value) => !value)
          }}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityLabel={check.name}
        >
          <View style={styles.leading}>
            <CircleX size={20} color={colors.statusRed} strokeWidth={2} />
          </View>
          <View style={styles.titles}>
            <Text style={styles.title} numberOfLines={1}>
              {check.name}
            </Text>
            <Text style={styles.subtitle} numberOfLines={1}>
              {duration
                ? t('pullRequest.screens.failedAfter', 'Failed after {{duration}}', { duration })
                : t('pullRequest.screens.failed', 'Failed')}
            </Text>
          </View>
        </Pressable>
        <Pressable
          ref={menuRef}
          onPress={() => setMenuOpen(true)}
          hitSlop={8}
          style={({ pressed }) => [styles.more, pressed && styles.morePressed]}
          accessibilityRole="button"
          accessibilityLabel={t('pullRequest.screens.checkActions', 'More for {{name}}', {
            name: check.name
          })}
        >
          <MoreHorizontal size={18} color={colors.textSecondary} strokeWidth={2.2} />
        </Pressable>
      </View>
      {open ? (
        <View style={styles.body}>
          {!entry || entry.status === 'loading' ? (
            <ActivityIndicator color={colors.textSecondary} style={styles.loading} />
          ) : entry.status === 'error' ? (
            <Text style={styles.muted}>{entry.message}</Text>
          ) : annotation ? (
            <View style={styles.error}>
              <Text style={styles.codeMuted} numberOfLines={1}>
                {annotation.locator}
              </Text>
              {annotation.title ? <Text style={styles.codeText}>{annotation.title}</Text> : null}
              <Text style={styles.codeError} numberOfLines={6}>
                {annotation.message}
              </Text>
            </View>
          ) : fallbackLine ? (
            <View style={styles.error}>
              <Text style={styles.codeText}>{fallbackLine}</Text>
            </View>
          ) : null}
          {actionable ? (
            <View style={styles.buttons}>
              <PrMiniButton
                bright
                icon={Sparkles}
                label={fixLabel}
                onPress={onFix}
                busy={fixBusy}
                disabled={!fixAvailable}
              />
              <PrMiniButton
                icon={RotateCw}
                label={t('pullRequest.screens.rerun', 'Rerun')}
                onPress={onRerun}
                busy={rerunBusy}
              />
            </View>
          ) : null}
          {copyFailed ? (
            <Text style={styles.copyFailed}>
              {t('pullRequest.screens.copyErrorFailed', 'Could not copy the error.')}
            </Text>
          ) : null}
          {showLog ? <PRCheckDetailView entry={entry} /> : null}
        </View>
      ) : null}
      <PullDownMenu
        visible={menuOpen}
        anchorRef={menuRef}
        groups={menuGroups}
        onClose={() => setMenuOpen(false)}
      />
    </View>
  )
}

function checkDuration(
  startedAt: string | null,
  completedAt: string | null,
  t: Translate
): string | null {
  const start = startedAt ? Date.parse(startedAt) : Number.NaN
  const end = completedAt ? Date.parse(completedAt) : Number.NaN
  const seconds = Math.round((end - start) / 1000)
  if (!Number.isFinite(seconds) || seconds < 0) {
    return null
  }
  if (seconds < 60) {
    return t('pullRequest.screens.durationSeconds', '{{seconds}}s', { seconds })
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return t('pullRequest.screens.durationMinutes', '{{minutes}}m {{seconds}}s', {
      minutes,
      seconds: seconds % 60
    })
  }
  return t('pullRequest.screens.durationHours', '{{hours}}h {{minutes}}m', {
    hours: Math.floor(minutes / 60),
    minutes: minutes % 60
  })
}

const INDENT = LIST_LEADING_SLOT + spacing.md

const styles = themedStyleSheet(() => ({
  row: { paddingHorizontal: LIST_ROW_PADDING, paddingVertical: spacing.md, gap: spacing.sm },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  headMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  leading: { width: LIST_LEADING_SLOT, alignItems: 'center' },
  titles: { flex: 1, gap: 2 },
  title: { color: colors.textPrimary, fontSize: 15, fontWeight: '500' },
  subtitle: { color: colors.textSecondary, fontSize: typography.metaSize },
  more: {
    width: 32,
    height: 32,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center'
  },
  morePressed: { backgroundColor: colors.bgRaised },
  body: { marginLeft: INDENT, gap: spacing.md },
  loading: { alignSelf: 'flex-start' },
  muted: { color: colors.textSecondary, fontSize: typography.bodySize },
  error: {
    borderLeftWidth: 2,
    borderLeftColor: colors.statusRed,
    paddingLeft: spacing.md,
    paddingVertical: 2,
    gap: 2
  },
  codeMuted: {
    color: colors.textMuted,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize
  },
  codeText: {
    color: colors.textPrimary,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize
  },
  codeError: {
    color: colors.statusRed,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize
  },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  copyFailed: { color: colors.statusRed, fontSize: 13 }
}))
