import { useEffect, useState, type ReactNode } from 'react'
import { ActivityIndicator, Text, View } from 'react-native'
import { CircleAlert, CircleCheck, SquareTerminal, WifiOff } from 'lucide-react-native'
import type { RemoteServerUpdateRestartImpact } from '../../../../../src/shared/remote-runtime/host-catalog/remote-server-update'
import { BottomDrawer } from '../../../components/bottom-drawer/BottomDrawer'
import { MobileStateView } from '../../../components/feedback/MobileStateView'
import { MobileAgentIcon } from '../../../components/icons/MobileAgentIcon'
import {
  LIST_LEADING_INSET,
  ListGroup,
  ListRow,
  SectionHeader
} from '../../../components/list/ListGroup'
import { SheetHeader } from '../../../components/nav-bar/SheetHeader'
import { SheetPrimaryButton } from '../../../components/sheets/SheetPrimaryButton'
import { mobileTuiAgentLabel } from '../../../agents/mobile-tui-agents'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import type { Translate } from '../../../i18n/mobile-i18n'
import { DownloadProgressBar } from '../../../mobile-web-shell/presentation/DownloadProgressBar'
import { createDownloadProgressFeed } from '../../../mobile-web-shell/presentation/download-progress-feed'
import { spacing } from '../../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../../theme/themed-styles'
import { useMobileColors } from '../../../theme/use-mobile-color-scheme'
import type { HostOrcaRestartImpact, HostOrcaUpdate } from './host-orca-update'
import { offeredOrcaVersion } from './host-orca-update-snapshot'

// Many running agents would push Restart off the screen; the rest fold into one "N more" row.
const RESTART_ROWS_SHOWN = 4
// About what the 180 pt value slot shows of "1.4.230 → 1.4.231" style text before it cuts off.
const VERSION_VALUE_CHARS = 24
// Long enough to read "Updated to"; the toast where the user is says it again.
const UPDATED_CLOSE_MS = 1500

/** One sheet for the whole Orca update on a computer: download, who restarts, restart, back online. */
export function HostOrcaUpdateSheet(props: {
  visible: boolean
  hostName: string
  update: HostOrcaUpdate
  online: boolean
  onClose: () => void
  onDownload: () => void
  onRestart: () => void
}) {
  const t = useMobileTranslation()
  const styles = useThemedStyles(stylesSheet)
  const { entry, snapshot, impact } = props.update
  const phase = entry?.phase ?? 'available'
  const installed = entry?.currentVersion ?? snapshot?.appVersion ?? ''
  const target = entry?.targetVersion ?? offeredOrcaVersion(snapshot)
  const [feed] = useState(createDownloadProgressFeed)
  const percent = phase === 'downloading' ? Math.round(entry?.progress ?? 0) : 0
  useEffect(() => feed.publish(percent / 100), [feed, percent])
  const { onClose } = props
  useEffect(() => {
    if (!props.visible || phase !== 'updated') {
      return
    }
    const timer = setTimeout(onClose, UPDATED_CLOSE_MS)
    return () => clearTimeout(timer)
  }, [props.visible, phase, onClose])

  const restarting = phase === 'restarting'
  const ended = phase === 'failed' || phase === 'updated'
  const leading = restarting
    ? t('host.updates.hide', 'Hide')
    : ended
      ? t('common.close', 'Close')
      : t('common.cancel', 'Cancel')
  const timedOut = phase === 'failed' && entry?.error === 'remote_update_reconnect_timeout'
  const versions = target
    ? t('host.updates.versions', '{{installed}} → {{latest}}', { installed, latest: target })
    : ''
  // A long build version (a prerelease or local build) would cut the target off in the value slot.
  const longVersions = versions.length > VERSION_VALUE_CHARS
  const versionRow =
    target && target !== installed ? (
      <ListGroup>
        <ListRow
          title={t('host.updates.version', 'Version')}
          {...(longVersions ? { subtitle: versions, subtitleLines: 3 } : { value: versions })}
        />
      </ListGroup>
    ) : null

  return (
    <BottomDrawer visible={props.visible} onClose={props.onClose}>
      <View>
        <SheetHeader
          title={t('host.updates.updateOrca', 'Update Orca')}
          subtitle={props.hostName}
          leading={{ label: leading, onPress: props.onClose }}
        />
        {restarting ? (
          <View style={styles.centred}>
            <ActivityIndicator size="small" />
            <Text style={styles.centredText}>
              {t('host.updates.restarting', 'Restarting Orca on {{host}}…', {
                host: props.hostName
              })}
            </Text>
          </View>
        ) : phase === 'updated' ? (
          <MobileStateView
            icon={CircleCheck}
            title={t('host.updates.updatedTo', 'Updated to {{version}}', {
              version: entry?.currentVersion ?? target ?? ''
            })}
          />
        ) : timedOut ? (
          <MobileStateView
            icon={WifiOff}
            title={t('host.updates.notBack', '{{host}} hasn’t come back', { host: props.hostName })}
            message={t('host.updates.mayStillInstall', 'It may still be installing.')}
            action={{
              label: t('host.updates.checkAgain', 'Check again'),
              onPress: props.onRestart
            }}
            // Back on its old version (an install that didn't take), only a fresh try moves it on.
            secondaryAction={
              props.online
                ? { label: t('host.updates.tryAgain', 'Try again'), onPress: props.onDownload }
                : null
            }
          />
        ) : phase === 'failed' ? (
          <MobileStateView
            icon={CircleAlert}
            title={t('host.updates.couldntUpdate', 'Couldn’t update')}
            message={orcaUpdateFailureLine(entry?.error ?? null, t)}
            details={entry?.error ?? null}
            action={
              props.online
                ? { label: t('host.updates.tryAgain', 'Try again'), onPress: props.onDownload }
                : null
            }
          />
        ) : phase === 'downloaded' ? (
          <>
            {versionRow}
            <RestartImpactList impact={impact} />
            <View style={styles.footer}>
              <SheetPrimaryButton
                label={t('host.updates.restartOrca', 'Restart Orca')}
                disabled={!props.online || impact?.state === 'loading'}
                busy={props.update.busy}
                onPress={props.onRestart}
              />
            </View>
          </>
        ) : phase === 'downloading' || phase === 'checking-update' ? (
          <>
            {versionRow}
            <View style={styles.progress}>
              <DownloadProgressBar
                feed={feed}
                receivedBytes={percent}
                totalBytes={100}
                accessibilityLabel={t('host.updates.downloading', 'Downloading')}
              />
              <Text style={styles.caption}>
                {t('host.updates.percent', '{{percent}}%', { percent })}
              </Text>
            </View>
          </>
        ) : (
          <>
            {versionRow}
            <View style={styles.footer}>
              <SheetPrimaryButton
                label={t('host.updates.download', 'Download')}
                disabled={!props.online || props.update.busy}
                onPress={props.onDownload}
              />
            </View>
          </>
        )}
      </View>
    </BottomDrawer>
  )
}

/** The host's failure in one line; Orca's own codes get words, anything else is the host's text. */
function orcaUpdateFailureLine(error: string | null, t: Translate): string {
  switch (error) {
    case null:
    case '':
      return t('host.updates.failedGeneric', 'The update stopped before it finished.')
    case 'remote_update_manual_required':
      return t('host.updates.failedManual', 'This computer has to be updated by hand.')
    case 'remote_update_not_available':
    case 'remote_update_status_unavailable':
    case 'remote_update_requested_version_unavailable':
      return t('host.updates.failedGone', 'The computer no longer offers this update.')
    case 'remote_update_download_incomplete':
    case 'remote_update_not_downloaded':
      return t('host.updates.failedDownload', 'The download was interrupted.')
    case 'remote_update_updater_timeout':
      return t('host.updates.failedTimeout', 'The computer stopped answering about the update.')
    case 'host_not_connected':
      return t('host.updates.failedOffline', 'Lost the connection to the computer.')
    default:
      return error
  }
}

function RestartImpactList(props: { impact: HostOrcaRestartImpact | null }) {
  const t = useMobileTranslation()
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  if (!props.impact || props.impact.state === 'loading') {
    return (
      <View style={styles.impactLoading}>
        <ActivityIndicator size="small" color={colors.textSecondary} />
      </View>
    )
  }
  if (props.impact.state === 'unknown') {
    return (
      <Text style={styles.note}>
        {t(
          'host.updates.impactUnknown',
          'Couldn’t check what’s running there. Agents and terminals Orca runs itself will stop.'
        )}
      </Text>
    )
  }
  const rows = restartRows(props.impact.impact, t, colors.textPrimary)
  if (rows.length === 0) {
    return null
  }
  const shown = rows.length > RESTART_ROWS_SHOWN ? rows.slice(0, RESTART_ROWS_SHOWN - 1) : rows
  const more = rows.length - shown.length
  return (
    <>
      <SectionHeader title={t('host.updates.willRestart', 'Will restart')} />
      <ListGroup separatorInset={LIST_LEADING_INSET}>
        {shown.map((row) => (
          <ListRow key={row.key} title={row.title} subtitle={row.subtitle} leading={row.leading} />
        ))}
        {more > 0 ? (
          <ListRow
            key="more"
            title={t('host.updates.moreRestart', '{{number}} more', { number: more })}
          />
        ) : null}
      </ListGroup>
    </>
  )
}

type RestartRow = {
  key: string
  title: string
  subtitle?: string
  leading: ReactNode
}

function restartRows(
  impact: RemoteServerUpdateRestartImpact,
  t: Translate,
  iconColor: string
): RestartRow[] {
  const chats: RestartRow[] = impact.chats.map((chat) => {
    const agent = chat.agent ? mobileTuiAgentLabel(chat.agent) : null
    return {
      key: chat.sessionId,
      title: chat.title ?? agent ?? t('host.updates.chat', 'Chat'),
      ...(chat.title && agent ? { subtitle: agent } : {}),
      leading: chat.agent ? <MobileAgentIcon agentId={chat.agent} size={20} /> : <View />
    }
  })
  const terminals = impact.terminalPtyIds.length
  return terminals === 0
    ? chats
    : [
        ...chats,
        {
          key: 'terminals',
          title:
            terminals === 1
              ? t('host.updates.terminals_one', '{{count}} terminal', { count: terminals })
              : t('host.updates.terminals_other', '{{count}} terminals', { count: terminals }),
          leading: <SquareTerminal size={18} color={iconColor} />
        }
      ]
}

const stylesSheet = themedStyleSheet((colors) => ({
  centred: {
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xl * 2,
    paddingHorizontal: spacing.lg
  },
  centredText: { fontSize: 13, color: colors.textSecondary, textAlign: 'center' },
  progress: { alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.xl },
  caption: { fontSize: 13, color: colors.textSecondary },
  footer: { marginTop: spacing.xl },
  impactLoading: { paddingVertical: spacing.lg, alignItems: 'center' },
  note: {
    marginTop: spacing.md,
    paddingHorizontal: spacing.lg,
    fontSize: 13,
    lineHeight: 18,
    color: colors.textSecondary
  }
}))
