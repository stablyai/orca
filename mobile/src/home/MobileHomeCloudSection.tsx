import { useRouter } from 'expo-router'
import { ChevronRight, Cloud, Pin, Plus, RotateCw } from 'lucide-react-native'
import { Fragment, useMemo, useState } from 'react'
import { ActivityIndicator, Alert, Pressable, Text, View } from 'react-native'
import { CloudStatusDot } from '../cloud/CloudStatusDot'
import { formatReadSnapshotAsOf } from '../cloud/CloudReadSnapshotSection'
import type { CloudWorkspace } from '../cloud/cloud-control-plane-client'
import { CloudEnrollmentError, enrollCloudDevice } from '../cloud/cloud-device-enrollment'
import { takeCloudReturnTo } from '../cloud/cloud-return-to'
import type { CloudEnrollment } from '../cloud/cloud-device-identity'
import { cloudRepoLine, cloudStatusLabel } from '../cloud/cloud-workspace-display'
import { useCloudWorkspaces } from '../cloud/use-cloud-workspaces'
import { useCloudWorkspacePrefs } from '../cloud/cloud-workspace-prefs'
import {
  arrangeCloudWorkspaces,
  setPinned
} from '../../../src/shared/cloud-workspaces/cloud-workspace-arrangement'
import { formatWorkspaceNumber } from '../../../src/shared/cloud-workspaces/cloud-workspaces-wire'
import { formatTimeAgo } from '../worktree/agent-row-display'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { homeListStyles as styles } from './home-list-styles'
import { MobileHomeSectionHeading } from './MobileHomeSectionHeading'
import { ORCA_CLOUD_IDLE_SLEEP_MINUTES } from '../../../src/shared/hosted-sandbox/hosted-sandbox-wire'

export type CloudEnrollDesktop = { name: string; client: RpcClient }

/** Home's Cloud section: this phone's own Orca Cloud workspaces, reached with no desktop in the path. */
export function MobileHomeCloudSection(props: {
  enrollment: CloudEnrollment | null | undefined
  /** A connected desktop that can lend its Orca sign-in once, to enroll this phone. */
  enrollDesktop: CloudEnrollDesktop | null
  deviceLabel: string
  onOpenWorkspace: (workspace: CloudWorkspace) => void
  onNewWorkspace: () => void
  onManageAccess: () => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const query = useCloudWorkspaces(props.enrollment)
  // Pins and order are the member's own and sync with their desktops.
  const prefs = useCloudWorkspacePrefs(props.enrollment?.deviceSessionId ?? null)
  const workspaces = useMemo(
    () =>
      arrangeCloudWorkspaces(
        (query.data ?? []).filter((workspace) => workspace.status !== 'archived'),
        prefs.document
      ).flatMap((group) =>
        group.rows.map((workspace) => ({ workspace, pinned: group.kind === 'pinned' }))
      ),
    [query.data, prefs.document]
  )
  if (props.enrollment === undefined) {
    return null
  }
  if (props.enrollment === null) {
    return <CloudConnectRow desktop={props.enrollDesktop} deviceLabel={props.deviceLabel} />
  }
  const togglePin = (workspace: CloudWorkspace, pinned: boolean) => {
    Alert.alert(workspace.title, undefined, [
      {
        text: pinned ? t('cloud.home.unpin', 'Unpin') : t('cloud.home.pin', 'Pin to top'),
        onPress: () =>
          void prefs
            .edit((doc) => setPinned(doc, workspace.id, !pinned))
            .then((saved) => {
              if (!saved) {
                Alert.alert(
                  t('cloud.home.pinFailed', 'Couldn’t save that change'),
                  t('cloud.home.pinFailedDetail', 'Check your connection and try again.')
                )
              }
            })
      },
      { text: t('common.cancel', 'Cancel'), style: 'cancel' }
    ])
  }
  const now = query.dataUpdatedAt || 0
  return (
    <>
      <MobileHomeSectionHeading
        title={t('cloud.home.heading', 'Cloud')}
        first={false}
        {...(workspaces.length > 0 ? { count: workspaces.length } : {})}
        aside={t('cloud.home.manage', 'Manage')}
        onAsidePress={props.onManageAccess}
      />
      <View style={styles.group}>
        {query.isPending ? (
          <View
            accessible
            accessibilityLabel={t('cloud.home.loading', 'Loading cloud workspaces…')}
          >
            <SkeletonRow />
            <View style={[styles.separator, styles.tileSeparator]} />
            <SkeletonRow />
          </View>
        ) : query.isError && workspaces.length === 0 ? (
          <Pressable
            accessibilityRole="button"
            style={({ pressed }) => [styles.actionRow, pressed && styles.rowPressed]}
            onPress={() => void query.refetch()}
          >
            <RotateCw size={16} color={colors.accentBlue} />
            <Text style={styles.actionLabel}>
              {t('cloud.home.retry', 'Couldn’t reach Orca Cloud. Try again')}
            </Text>
          </Pressable>
        ) : workspaces.length === 0 ? (
          <View style={[styles.row, local.empty]}>
            <View style={styles.text}>
              <Text style={styles.title}>
                {t('cloud.home.emptyTitle', 'No cloud workspaces yet')}
              </Text>
              <Text style={styles.subtitle}>
                {t(
                  'cloud.home.emptyDetail',
                  'Start one here. It keeps running while this phone and your computer sleep.'
                )}
              </Text>
              <Text style={styles.subtitle}>
                {t('cloud.idle.sleeps', 'Sleeps after {{count}} minutes idle.', {
                  count: ORCA_CLOUD_IDLE_SLEEP_MINUTES,
                  defaultValue_one: 'Sleeps after {{count}} minute idle.'
                })}
              </Text>
            </View>
          </View>
        ) : (
          workspaces.map(({ workspace, pinned }) => (
            <Fragment key={workspace.id}>
              <CloudWorkspaceRow
                workspace={workspace}
                pinned={pinned}
                now={now}
                onPress={() => props.onOpenWorkspace(workspace)}
                onLongPress={() => togglePin(workspace, pinned)}
              />
              <View style={[styles.separator, styles.tileSeparator]} />
            </Fragment>
          ))
        )}
        {workspaces.length === 0 && !query.isPending ? (
          <View style={[styles.separator, styles.fullSeparator]} />
        ) : null}
        <Pressable
          accessibilityRole="button"
          style={({ pressed }) => [styles.actionRow, pressed && styles.rowPressed]}
          onPress={props.onNewWorkspace}
        >
          <Plus size={18} color={colors.accentBlue} />
          <Text style={styles.actionLabel}>{t('cloud.home.new', 'New cloud workspace')}</Text>
        </Pressable>
      </View>
    </>
  )
}

function SkeletonRow() {
  return (
    <View style={styles.row} importantForAccessibility="no-hide-descendants">
      <View style={styles.tile} />
      <View style={[styles.text, local.skeletonText]}>
        <View style={[local.skeletonBar, { width: '55%' }]} />
        <View style={[local.skeletonBar, { width: '80%' }]} />
      </View>
    </View>
  )
}

function CloudWorkspaceRow({
  workspace,
  pinned,
  now,
  onPress,
  onLongPress
}: {
  workspace: CloudWorkspace
  pinned: boolean
  now: number
  onPress: () => void
  onLongPress: () => void
}) {
  const t = useMobileTranslation()
  const status = cloudStatusLabel(workspace.status, t)
  // The repo is already the title for most workspaces; then the branch is what tells them apart.
  const repoName = workspace.repo?.url
    .replace(/\.git$/, '')
    .split('/')
    .findLast(Boolean)
  const reference = now || workspace.createdAt
  // With no branch to tell same-named workspaces apart, when each was made does.
  const lastActive = workspace.lastActivityAt ?? workspace.createdAt
  const createdLine = repoName === workspace.title && !workspace.repo?.branch
  const detail =
    repoName !== workspace.title
      ? cloudRepoLine(workspace)
      : !createdLine
        ? workspace.repo?.branch
        : reference - workspace.createdAt < 60_000
          ? t('cloud.home.createdJustNow', 'Created just now')
          : t('cloud.home.createdAgo', 'Created {{ago}} ago', {
              ago: formatTimeAgo(workspace.createdAt, reference)
            })
  // "Created just now · just now" says one thing twice: the activity time adds nothing yet.
  // Asleep with a saved read-only copy: say how fresh that copy is; it opens without waking.
  const when =
    workspace.status === 'sleeping' && workspace.readSnapshotAt
      ? formatReadSnapshotAsOf(
          workspace.readSnapshotAt,
          Math.max(reference, workspace.readSnapshotAt),
          t
        )
      : createdLine && lastActive - workspace.createdAt < 60_000
        ? null
        : formatTimeAgo(lastActive, reference)
  const number = workspace.number ? formatWorkspaceNumber(workspace.number) : null
  const line = [status, number, detail, when].filter(Boolean).join(' · ')
  const optionsLabel = pinned ? t('cloud.home.unpin', 'Unpin') : t('cloud.home.pin', 'Pin to top')
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t(
        'cloud.home.workspaceRowLabel',
        'Cloud workspace, {{title}}, {{detail}}',
        {
          title: workspace.title,
          detail: line
        }
      )}
      accessibilityHint={pinned ? t('cloud.home.pinnedHint', 'Pinned') : undefined}
      accessibilityActions={[{ name: 'longpress', label: optionsLabel }]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === 'longpress') {
          onLongPress()
        }
      }}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={400}
    >
      <View style={styles.tile}>
        <Cloud size={17} strokeWidth={1.8} color={colors.textPrimary} />
        <View style={local.dotRing}>
          <CloudStatusDot status={workspace.status} size={10} />
        </View>
      </View>
      <View style={styles.text}>
        <Text style={styles.title} numberOfLines={1}>
          {workspace.title}
        </Text>
        <Text style={styles.subtitle} numberOfLines={2}>
          <Text style={workspace.status === 'failed' ? { color: colors.statusRed } : undefined}>
            {status}
          </Text>
          {[number, detail, when]
            .filter(Boolean)
            .map((part) => ` · ${part}`)
            .join('')}
        </Text>
      </View>
      <View style={styles.trailing}>
        {pinned ? <Pin size={14} color={colors.textMuted} /> : null}
        <ChevronRight size={18} color={colors.textMuted} />
      </View>
    </Pressable>
  )
}

function CloudConnectRow({
  desktop,
  deviceLabel
}: {
  desktop: CloudEnrollDesktop | null
  deviceLabel: string
}) {
  const t = useMobileTranslation()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const connect = async () => {
    if (!desktop || busy) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      await enrollCloudDevice({ desktop: desktop.client, desktopName: desktop.name, deviceLabel })
      // Arrived here from a team link opened before connecting: go back to that workspace.
      const next = takeCloudReturnTo()
      if (next) {
        router.push(next)
      }
    } catch (failure) {
      const kind = failure instanceof CloudEnrollmentError ? failure.failure : 'unreachable'
      setError(
        kind === 'signed-out'
          ? t('cloud.connect.signedOut', 'Sign in to Orca on {{desktop}}, then try again.', {
              desktop: desktop.name
            })
          : kind === 'not-offered'
            ? t(
                'cloud.connect.notOffered',
                '{{desktop}} doesn’t have Orca Cloud yet. Update Orca there, then try again.',
                { desktop: desktop.name }
              )
            : t(
                'cloud.connect.unreachable',
                'Couldn’t reach Orca Cloud through {{desktop}}. Try again.',
                { desktop: desktop.name }
              )
      )
    } finally {
      setBusy(false)
    }
  }
  const subtitle = desktop
    ? t(
        'cloud.connect.subtitle',
        'Open cloud workspaces from this phone, even when {{desktop}} is off. Uses its Orca sign-in once.',
        { desktop: desktop.name }
      )
    : t(
        'cloud.connect.noDesktop',
        'Open Orca on a computer you’re signed in to, then connect from here.'
      )
  return (
    <>
      <MobileHomeSectionHeading title={t('cloud.home.heading', 'Cloud')} first={false} />
      <View style={styles.group}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !desktop || busy, busy }}
          disabled={!desktop || busy}
          style={({ pressed }) => [
            styles.row,
            pressed && styles.rowPressed,
            !desktop && styles.rowDisabled
          ]}
          onPress={() => void connect()}
        >
          <View style={[styles.tile, local.connectTile]}>
            <Cloud size={17} strokeWidth={2} color={colors.onAccent} />
          </View>
          <View style={styles.text}>
            <Text style={[styles.title, local.connectTitle]}>
              {t('cloud.connect.title', 'Connect Orca Cloud')}
            </Text>
            <Text style={styles.subtitle}>{subtitle}</Text>
            {error ? (
              <Text style={[styles.detail, { color: colors.statusRed }]} accessibilityRole="alert">
                {error}
              </Text>
            ) : null}
          </View>
          <View style={styles.trailing}>
            {busy ? (
              <ActivityIndicator size="small" color={colors.textMuted} />
            ) : (
              <ChevronRight size={18} color={colors.textMuted} />
            )}
          </View>
        </Pressable>
      </View>
    </>
  )
}

const local = themedStyleSheet(() => ({
  dotRing: {
    position: 'absolute',
    right: -5,
    bottom: -5,
    padding: 2,
    borderRadius: 999,
    backgroundColor: colors.bgPanel
  },
  empty: { paddingRight: 16 },
  skeletonText: { gap: 8, paddingVertical: 14 },
  skeletonBar: { height: 10, borderRadius: 5, backgroundColor: colors.bgRaised },
  connectTile: { backgroundColor: colors.accentBlue },
  connectTitle: { color: colors.accentBlue, fontWeight: '600' }
}))
