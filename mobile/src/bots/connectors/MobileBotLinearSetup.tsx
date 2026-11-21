// Connect Linear as a page inside the bot's settings: the desktop's BotLinearSetupFlow. Linear's sign-in
// returns to 127.0.0.1 on the host, so it opens in Orca's browser there and the phone waits; the steps
// after it (pick, admin install, turn on) are all here.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { View } from 'react-native'
import { ArrowUpRight } from 'lucide-react-native'
import { botLinearWorkspaces, type BotLinearLink } from '../../../../src/shared/bot-types'
import type { ConnectorLinearWorkspace } from '../../../../src/shared/connector-bot-linear-contract'
import { BOT_LINEAR_OFF } from '../../../../src/shared/connector-bot-linear-contract'
import { MobileStateView } from '../../components/feedback/MobileStateView'
import { ListRow } from '../../components/list/ListGroup'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { SheetPrimaryButton } from '../../components/sheets/SheetPrimaryButton'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useBackClaim } from '../../navigation/use-back-claim'
import { useClipboardWriter } from '../../platform/clipboard/clipboard'
import { SettingsNote, SettingsSection } from '../../settings/settings-screen-frame'
import { colors, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { PhoneBot } from '../host-bots-operations'
import { MobileConnectorSourceIcon } from '../MobileConnectorSourceIcon'
import { ConnectorHandoff, useFollowHost } from './MobileConnectorAccountParts'
import { connectorAccountErrorMessage, linearWorkspaceLabel } from './mobile-connector-account-copy'
import type { PhoneLinearView } from './use-phone-connector-account'
import { usePhoneConnectTrip } from './use-phone-connect-trip'

// Linear never returns from its own error page, so after this long the wait says what it likely is.
const STUCK_MS = 30_000

type Step =
  | { kind: 'checking' }
  | { kind: 'failed'; code: string }
  | { kind: 'connect'; error: string | null }
  | { kind: 'pick'; workspaces: ConnectorLinearWorkspace[] }
  | { kind: 'waiting'; since: number }
  | { kind: 'needs-admin'; workspace: ConnectorLinearWorkspace; installUrl: string }
  | { kind: 'turn-on'; workspace: ConnectorLinearWorkspace }

/** The workspaces with `workspace` on: it keeps its place, or a new one goes last (withLinearWorkspace). */
function withWorkspace(
  current: readonly BotLinearLink[],
  workspace: ConnectorLinearWorkspace
): BotLinearLink[] {
  const turnedOn = {
    workspaceId: workspace.workspaceId,
    workspaceName: workspace.name,
    urlKey: workspace.urlKey
  }
  const at = current.findIndex((entry) => entry.workspaceId === workspace.workspaceId)
  return at === -1
    ? [...current, turnedOn]
    : current.map((entry, index) => (index === at ? turnedOn : entry))
}

export function MobileBotLinearSetup(props: {
  client: RpcClient | null
  bot: PhoneBot
  /** A row's own workspace; none from Add a connector, which picks another than the bot's. */
  workspaceId: string | undefined
  linear: { view: PhoneLinearView; refresh: () => Promise<void> }
  hostName: string
  online: boolean
  banner: ReactNode
  showToast: (message: string, durationMs?: number) => void
  save: (updates: { linearWorkspaces: BotLinearLink[] }) => Promise<boolean>
  onClose: () => void
  /** Turned on: the workspace's page takes over. */
  onDone: (workspaceId: string) => void
}) {
  const t = useMobileTranslation()
  const { bot, linear, hostName } = props
  const clipboard = useClipboardWriter()
  const [picked, setPicked] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const { trip, start, cancel } = usePhoneConnectTrip(
    props.client,
    'linear',
    bot.folderWorkspaceId,
    linear.refresh
  )
  useBackClaim(() => {
    props.onClose()
    return true
  })

  const taken =
    props.workspaceId === undefined
      ? botLinearWorkspaces(bot).map((entry) => entry.workspaceId)
      : []
  const step = ((): Step => {
    if (trip.status === 'waiting') {
      return { kind: 'waiting', since: trip.since }
    }
    if (linear.view.status === 'loading') {
      return { kind: 'checking' }
    }
    if (linear.view.status === 'failed') {
      return { kind: 'failed', code: linear.view.error }
    }
    const { workspaces, installUrl } = linear.view.value
    // The trip's workspace first, then the row's own, then the only one linked.
    const wanted =
      trip.status === 'linked' ? trip.link?.workspace?.id : (picked ?? props.workspaceId)
    const open = workspaces.filter((entry) => !taken.includes(entry.workspaceId))
    const workspace =
      workspaces.find((entry) => entry.workspaceId === wanted) ??
      (open.length === 1 ? open[0] : null)
    if (!workspace) {
      return open.length > 1
        ? { kind: 'pick', workspaces: open }
        : { kind: 'connect', error: trip.status === 'failed' ? trip.error : null }
    }
    return workspace.installed
      ? { kind: 'turn-on', workspace }
      : { kind: 'needs-admin', workspace, installUrl }
  })()

  const turnOn = async (workspace: ConnectorLinearWorkspace) => {
    setSaving(true)
    const saved = await props.save({
      linearWorkspaces: withWorkspace(botLinearWorkspaces(bot), workspace)
    })
    setSaving(false)
    if (saved) {
      props.showToast(t('bots.linear.setup.isOn', '{{name}} is on Linear', { name: bot.name }))
      props.onDone(workspace.workspaceId)
    }
  }
  // The sign-in was for turning the bot on: once it links an installed workspace, it turns on there.
  const resumed = useRef(false)
  const linkedTurnOn = trip.status === 'linked' && step.kind === 'turn-on' ? step.workspace : null
  useEffect(() => {
    if (linkedTurnOn && !resumed.current) {
      resumed.current = true
      void turnOn(linkedTurnOn)
    }
  })

  const waiting = step.kind === 'waiting'
  useEffect(() => {
    if (!waiting) {
      return
    }
    const timer = setInterval(() => setNow(Date.now()), 5_000)
    return () => clearInterval(timer)
  }, [waiting])
  const { refresh } = linear
  // An admin installs whenever they get to it, so the step follows the host while it shows.
  useFollowHost(step.kind === 'needs-admin', refresh)

  const error = (code: string) => connectorAccountErrorMessage('linear', code, hostName, t)
  const another = (
    <ListRow
      leading={<ArrowUpRight size={18} color={colors.textPrimary} />}
      title={t('bots.linear.connect.another', 'Use another workspace')}
      disabled={!props.online}
      onPress={() => start(true)}
    />
  )
  const signedIn = (workspace: ConnectorLinearWorkspace) => (
    <SettingsNote>
      {t('bots.connect.signedInAs', 'Signed in as {{who}}', {
        who: t('bots.linear.connect.who', '{{name}} in {{workspace}}', {
          name: workspace.userName || workspace.userId,
          workspace: linearWorkspaceLabel(workspace.name, workspace.urlKey)
        })
      })}
    </SettingsNote>
  )
  const body = (() => {
    switch (step.kind) {
      case 'checking':
        return (
          <MobileStateView loading title={t('bots.linear.setup.checking', 'Checking Linear…')} />
        )
      case 'failed':
        return (
          <MobileStateView
            iconElement={<MobileConnectorSourceIcon source="linear" size={28} />}
            title={error(step.code)}
            action={
              step.code === BOT_LINEAR_OFF || !props.online
                ? null
                : {
                    label: t('bots.linear.setup.retry', 'Try again'),
                    onPress: () => void refresh()
                  }
            }
          />
        )
      case 'connect':
        return (
          <MobileStateView
            iconElement={<MobileConnectorSourceIcon source="linear" size={28} />}
            title={t(
              'bots.linear.connect.pickWorkspace',
              'Sign in and pick the Linear workspace {{name}} works in.',
              { name: bot.name }
            )}
            message={step.error ? error(step.error) : undefined}
          >
            <SheetPrimaryButton
              label={t('bots.linear.connect.button', 'Connect Linear')}
              icon={ArrowUpRight}
              disabled={!props.online}
              onPress={() => start()}
            />
            <SettingsNote>
              {t('bots.connect.opensOnHost', 'Opens in Orca’s browser on {{host}}.', {
                host: hostName
              })}
            </SettingsNote>
          </MobileStateView>
        )
      case 'waiting':
        return (
          <ConnectorHandoff
            hostName={hostName}
            message={t(
              'bots.linear.connect.handoff',
              'Linear’s sign-in is open in Orca’s browser there. Pick the workspace and choose Authorize; this updates when you finish.'
            )}
            waiting={t(
              'bots.linear.connect.waitingOn',
              'Finish signing in to Linear on {{host}}…',
              {
                host: hostName
              }
            )}
            stuck={
              now - step.since > STUCK_MS
                ? t(
                    'bots.linear.connect.stuck',
                    'Stuck on a Linear page that says “Could not find OAuth client”? Orca’s Linear app isn’t open to this workspace yet. An admin of the workspace that owns the app must make it public.'
                  )
                : null
            }
            onCancel={cancel}
          />
        )
      case 'pick':
        return (
          <>
            {trip.status === 'failed' ? (
              <SettingsNote error>{error(trip.error)}</SettingsNote>
            ) : null}
            <SettingsSection
              first
              title={t('bots.linear.connect.pick', 'Choose a Linear workspace.')}
            >
              {step.workspaces.map((entry) => (
                <ListRow
                  key={entry.workspaceId}
                  leading={<MobileConnectorSourceIcon source="linear" size={20} />}
                  title={linearWorkspaceLabel(entry.name, entry.urlKey)}
                  navigates
                  onPress={() => setPicked(entry.workspaceId)}
                />
              ))}
              {another}
            </SettingsSection>
          </>
        )
      case 'needs-admin':
        return (
          <>
            {signedIn(step.workspace)}
            <SettingsNote>
              {t(
                'bots.linear.setup.install',
                'Orca is not installed in {{workspace}} yet. A Linear admin installs it once for everyone.',
                { workspace: linearWorkspaceLabel(step.workspace.name, step.workspace.urlKey) }
              )}
            </SettingsNote>
            <SettingsSection>
              <ListRow
                title={t('bots.linear.setup.copyForAdmin', 'Copy admin link')}
                value={t('bots.linear.setup.installing', 'Waiting for the install…')}
                onPress={() =>
                  void clipboard
                    .writeText(step.installUrl)
                    .then(() => props.showToast(t('bots.linear.setup.copied', 'Link copied.')))
                }
              />
              {another}
            </SettingsSection>
          </>
        )
      case 'turn-on':
        return (
          <>
            {signedIn(step.workspace)}
            <SettingsSection>{another}</SettingsSection>
            <View style={styles.action}>
              <SheetPrimaryButton
                label={t('bots.linear.connect.turnOn', 'Turn on {{name}}', { name: bot.name })}
                busy={saving}
                disabled={!props.online}
                onPress={() => void turnOn(step.workspace)}
              />
            </View>
          </>
        )
    }
  })()
  return (
    <>
      <SheetHeader
        title={t('bots.linear.setup.connectTitle', 'Connect Linear')}
        subtitle={t('bots.setup.for', 'for {{name}}', { name: bot.name })}
        leading={{ label: t('bots.linear.setup.close', 'Close'), onPress: props.onClose }}
      />
      {props.banner}
      {body}
    </>
  )
}

const styles = themedStyleSheet(() => ({
  action: { marginTop: spacing.lg }
}))
