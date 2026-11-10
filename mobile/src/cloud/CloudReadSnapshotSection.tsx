import { ExternalLink } from 'lucide-react-native'
import { useEffect, useRef, useState } from 'react'
import { Animated, Easing, Linking, Pressable, Text, View } from 'react-native'
import type {
  ReadSnapshot,
  ReadSnapshotGit,
  ReadSnapshotPr
} from '../../../src/shared/cloud-workspaces/read-snapshot'
import type { Translate } from '../i18n/mobile-i18n'
import { getUiIntlLocale } from '../i18n/ui-intl-locale'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useReducedMotionEnabled } from '../platform/use-reduced-motion'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { formatTimeAgo } from '../worktree/agent-row-display'
import { CloudErrorBanner } from './CloudErrorBanner'
import { CloudStatusDot } from './CloudStatusDot'
import { CloudReadSnapshotSessions } from './CloudReadSnapshotSessions'
import { CloudReadSnapshotRefusedError, type CloudReadSnapshotResult } from './cloud-read-snapshot'
import { readSnapshotStyles as styles } from './cloud-read-snapshot-styles'
import { readSnapshotRefusedMessage } from './cloud-workspace-copy'
import { cloudStatusLabel } from './cloud-workspace-display'
import { cloudWorkspaceScreenStyles as screen } from './cloud-workspace-screen-styles'

const GIT_PATHS_SHOWN = 5

export function formatReadSnapshotAbsolute(at: number): string {
  try {
    return new Intl.DateTimeFormat(getUiIntlLocale(), {
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(at)
  } catch {
    return new Date(at).toLocaleString()
  }
}

/** "As of 5m ago" (relative); the absolute time is the long-press / screen-reader form. */
export function formatReadSnapshotAsOf(at: number, now: number, t: Translate): string {
  return now - at < 60_000
    ? t('cloud.snapshot.asOfJustNow', 'As of just now')
    : t('cloud.snapshot.asOf', 'As of {{ago}} ago', { ago: formatTimeAgo(at, now) })
}

/**
 * The asleep workspace's read-only "Latest from this workspace": what its PR, agents and git looked
 * like when it went to sleep, opened on this phone. Never wakes the sandbox.
 */
export function CloudReadSnapshotSection(props: {
  result: CloudReadSnapshotResult | undefined
  /** When the result was fetched: the clock "As of" counts from (no impure clock read in render). */
  fetchedAt: number
  loading: boolean
  /** Wake was tapped: the header says Waking (the copy stays readable until it is open). */
  waking: boolean
  onRetry: () => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { result } = props
  // Gone or not openable: the screen itself says so; this area has nothing to add.
  if (!props.loading && result?.state === 'not_found') {
    return null
  }
  return (
    <View style={screen.section}>
      <View style={styles.headingRow}>
        <Text style={[screen.sectionHeading, styles.headingText]} accessibilityRole="header">
          {t('cloud.snapshot.heading', 'Latest from this workspace')}
        </Text>
        <View style={styles.headingState} accessible accessibilityLiveRegion="polite">
          <CloudStatusDot status={props.waking ? 'waking' : 'sleeping'} size={8} />
          <Text style={styles.headingStateText}>
            {cloudStatusLabel(props.waking ? 'waking' : 'sleeping', t)}
          </Text>
        </View>
      </View>
      {props.loading || !result ? (
        <SnapshotSkeleton />
      ) : result.state === 'ready' ? (
        <SnapshotBody snapshot={result.snapshot} now={props.fetchedAt} />
      ) : result.state === 'no_snapshot' ? (
        <Notice
          text={t(
            'cloud.snapshot.empty',
            'Nothing saved yet. Orca saves a read-only copy each time this workspace goes to sleep.'
          )}
        />
      ) : result.state === 'not_sealed_for_key' ? (
        <Notice
          text={t(
            'cloud.snapshot.notSealedForKey',
            'This device was added after the workspace went to sleep. Wake it once to read it here.'
          )}
        />
      ) : result.state === 'error' && result.error instanceof CloudReadSnapshotRefusedError ? (
        // Trying again cannot help: the real copy only comes back from waking the workspace.
        <CloudErrorBanner
          message={readSnapshotRefusedMessage(result.error.reason, t)}
          onRetry={null}
        />
      ) : (
        <CloudErrorBanner
          message={t(
            'cloud.snapshot.error',
            'Couldn’t load the latest from this workspace. Your files are safe.'
          )}
          onRetry={props.onRetry}
        />
      )}
    </View>
  )
}

function Notice({ text }: { text: string }) {
  return (
    <View style={styles.notice} accessible accessibilityRole="text">
      <Text style={styles.noticeText}>{text}</Text>
    </View>
  )
}

function SnapshotSkeleton() {
  const t = useMobileTranslation()
  const reducedMotion = useReducedMotionEnabled() !== false
  const pulse = useRef(new Animated.Value(1)).current
  useEffect(() => {
    if (reducedMotion) {
      pulse.setValue(1)
      return
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 0.45,
          duration: 800,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true
        }),
        Animated.timing(pulse, {
          toValue: 1,
          duration: 800,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true
        })
      ])
    )
    loop.start()
    return () => loop.stop()
  }, [reducedMotion, pulse])
  return (
    <Animated.View
      style={[styles.skeletonCard, { opacity: pulse }]}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={t('cloud.snapshot.loading', 'Loading the latest from this workspace…')}
    >
      <View style={[styles.skeletonBar, { width: '35%' }]} />
      <View style={[styles.skeletonBar, { width: '80%' }]} />
      <View style={[styles.skeletonBar, { width: '60%' }]} />
    </Animated.View>
  )
}

function SnapshotBody({ snapshot, now }: { snapshot: ReadSnapshot; now: number }) {
  const t = useMobileTranslation()
  const [absolute, setAbsolute] = useState(false)
  const exact = formatReadSnapshotAbsolute(snapshot.capturedAt)
  const empty = !snapshot.pr && !snapshot.git && snapshot.sessions.length === 0
  return (
    <View>
      <Pressable
        accessibilityRole="text"
        accessibilityLabel={t('cloud.snapshot.asOfExact', 'As of {{time}}', { time: exact })}
        onLongPress={() => setAbsolute((value) => !value)}
        style={styles.asOfButton}
      >
        <Text style={styles.asOf}>
          {absolute
            ? t('cloud.snapshot.asOfExact', 'As of {{time}}', { time: exact })
            : formatReadSnapshotAsOf(snapshot.capturedAt, Math.max(now, snapshot.capturedAt), t)}
        </Text>
      </Pressable>
      <View style={styles.stack}>
        {snapshot.pr ? <PrCard pr={snapshot.pr} /> : null}
        <CloudReadSnapshotSessions sessions={snapshot.sessions} />
        {snapshot.git ? <GitCard git={snapshot.git} /> : null}
        {empty ? (
          <Notice
            text={t(
              'cloud.snapshot.quiet',
              'No agents, changes or pull request when it went to sleep.'
            )}
          />
        ) : null}
      </View>
    </View>
  )
}

function prStateLabel(pr: ReadSnapshotPr, t: Translate): string {
  switch (pr.state.toLowerCase()) {
    case 'merged':
      return t('cloud.snapshot.pr.merged', 'Merged')
    case 'closed':
      return t('cloud.snapshot.pr.closed', 'Closed')
    case 'draft':
      return t('cloud.snapshot.pr.draft', 'Draft')
    default:
      return t('cloud.snapshot.pr.open', 'Open')
  }
}

function prChecksLabel(pr: ReadSnapshotPr, t: Translate): string | null {
  switch (pr.checksStatus?.toLowerCase()) {
    case 'success':
    case 'passed':
    case 'passing':
      return t('cloud.snapshot.checks.passing', 'Checks passing')
    case 'failure':
    case 'failed':
    case 'failing':
      return t('cloud.snapshot.checks.failing', 'Checks failing')
    case 'pending':
    case 'running':
      return t('cloud.snapshot.checks.pending', 'Checks running')
    // No status, or one this build doesn't name: the VM's own summary line, if any.
    case undefined:
    default:
      return pr.checksSummary
  }
}

function PrCard({ pr }: { pr: ReadSnapshotPr }) {
  const t = useMobileTranslation()
  const failing = /fail/i.test(pr.checksStatus ?? '')
  const meta = [prStateLabel(pr, t), prChecksLabel(pr, t)].filter(Boolean).join(' · ')
  const title = t('cloud.snapshot.pr.title', '#{{number}} {{title}}', {
    number: pr.number,
    title: pr.title
  })
  return (
    <View style={screen.card}>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`${title}, ${meta}`}
        accessibilityHint={t('cloud.snapshot.pr.hint', 'Opens the pull request')}
        onPress={() => void Linking.openURL(pr.url).catch(() => undefined)}
        style={({ pressed }) => [styles.row, pressed && screen.pressed]}
      >
        <View style={styles.rowText}>
          <Text style={styles.rowTitle} numberOfLines={2}>
            {title}
          </Text>
          <Text style={[styles.rowMeta, failing && { color: colors.statusRed }]} numberOfLines={1}>
            {meta}
          </Text>
        </View>
        <ExternalLink size={16} color={colors.textMuted} />
      </Pressable>
    </View>
  )
}

function GitCard({ git }: { git: ReadSnapshotGit }) {
  const t = useMobileTranslation()
  const count = git.changeCount
  const files =
    count === 1
      ? t('cloud.snapshot.git.files_one', '{{count}} changed file', { count })
      : t('cloud.snapshot.git.files_other', '{{count}} changed files', { count })
  const more = count - Math.min(git.changes.length, GIT_PATHS_SHOWN)
  return (
    <View style={screen.card}>
      <View style={styles.gitBody} accessible>
        {git.branch ? (
          <Text style={styles.rowTitle} numberOfLines={1}>
            {git.branch}
          </Text>
        ) : null}
        <View style={styles.gitHeadline}>
          <Text style={styles.rowMeta}>
            {count === 0 ? t('cloud.snapshot.git.clean', 'No uncommitted changes') : files}
          </Text>
          {git.added !== null ? (
            <Text style={[styles.mono, styles.added]}>+{git.added}</Text>
          ) : null}
          {git.removed !== null ? (
            <Text style={[styles.mono, styles.removed]}>−{git.removed}</Text>
          ) : null}
        </View>
        {git.changes.slice(0, GIT_PATHS_SHOWN).map((change) => (
          <Text key={`${change.area}:${change.path}`} style={styles.mono} numberOfLines={1}>
            {change.path}
          </Text>
        ))}
        {more > 0 ? (
          <Text style={styles.rowMeta}>
            {more === 1
              ? t('cloud.snapshot.git.more_one', 'and {{count}} more', { count: more })
              : t('cloud.snapshot.git.more_other', 'and {{count}} more', { count: more })}
          </Text>
        ) : null}
      </View>
    </View>
  )
}
