// Connect Slack as a page inside the bot's settings: the desktop's BotSlackSetupDialog and SlackConfigTokenForm,
// for a phone. No hand-off (it needs the desktop's own Orca account) and no clipboard read on return: Paste
// stands in for it.
import { useState, type ReactNode } from 'react'
import { ActivityIndicator } from 'react-native'
import { ArrowUpRight } from 'lucide-react-native'
import {
  SLACK_CONFIG_REFRESH_TOKEN_PREFIX,
  slackAppMessagesUrl,
  slackConfigTokenKind,
  slackTeamState
} from '../../../../src/shared/connector-bot-slack-contract'
import { TextField } from '../../components/composer-input/TextField'
import { MobileStateView } from '../../components/feedback/MobileStateView'
import { LIST_LEADING_INSET, LIST_ROW_PADDING, ListRow } from '../../components/list/ListGroup'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { StepNumber } from '../tools/MobileBotToolSignInPage'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useBackClaim } from '../../navigation/use-back-claim'
import { useClipboardReader } from '../../platform/clipboard/clipboard'
import { openExternalLink } from '../../platform/external-links/external-link'
import { SettingsNote, SettingsSection } from '../../settings/settings-screen-frame'
import { themedStyleSheet, useThemedStyles } from '../../theme/themed-styles'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { PhoneBot } from '../host-bots-operations'
import { MobileBotTextButton } from '../MobileBotTextButton'
import { MobileConnectorLogo } from '../MobileConnectorSourceIcon'
import { slackErrorMessage } from './mobile-slack-copy'
import { MobileConnectorTryIt } from './MobileConnectorTryIt'
import { SlackPickStep, SlackProblemStep } from './MobileSlackSetupSteps'
import type { PhoneSlackView } from './use-phone-bot-slack'
import { usePhoneSlackSetup } from './use-phone-slack-setup'

// Where Slack lists "Your App Configuration Tokens".
const SLACK_APPS_URL = 'https://api.slack.com/apps'
const TOKEN_PLACEHOLDER = `${SLACK_CONFIG_REFRESH_TOKEN_PREFIX}…`

export function MobileBotSlackSetup(props: {
  client: RpcClient | null
  botId: string
  botName: string
  teamId: string | undefined
  inSlack: boolean
  knownTeams: readonly string[]
  /** The host's bots, whose Slack reads name the workspaces to pick from. */
  hostBots: readonly PhoneBot[]
  slack: { view: PhoneSlackView; refresh: () => Promise<PhoneSlackView> }
  hostName: string
  online: boolean
  banner: ReactNode
  showToast: (message: string) => void
  onClose: () => void
  /** Installed, after Try it: the workspace's page takes over. */
  onInstalled: (teamId: string) => void
}) {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const setup = usePhoneSlackSetup({ ...props, t })
  const { step } = setup
  const [token, setToken] = useState('')
  const [accessPasted, setAccessPasted] = useState(false)
  const [checked, setChecked] = useState(false)
  const clipboard = useClipboardReader()
  useBackClaim(() => {
    if (step.kind === 'installed') {
      props.onInstalled(step.teamId)
    } else {
      props.onClose()
    }
    return true
  })

  const send = (value: string) => {
    setToken('')
    setAccessPasted(false)
    setup.submitToken(value)
  }
  // A pasted refresh token goes straight in, as on the desktop; the access token gets a pointer to the other.
  const take = (text: string) => {
    const kind = slackConfigTokenKind(text)
    if (kind === 'refresh' && props.online) {
      send(text.trim())
    } else if (kind === 'access') {
      setToken('')
      setAccessPasted(true)
    } else {
      setAccessPasted(false)
      setToken(text)
    }
  }
  // Only text that lands at once is a paste; typed text waits for Create.
  const change = (text: string) => {
    if (text.length - token.length > 1) {
      take(text)
    } else {
      setAccessPasted(false)
      setToken(text)
    }
  }
  const trimmed = token.trim()
  const tokenStep = step.kind === 'token' ? step : null
  const canCreate = tokenStep !== null && trimmed.length > 0 && props.online

  if (step.kind === 'installed') {
    const team =
      props.slack.view.status === 'ready'
        ? slackTeamState(props.slack.view.slack, step.teamId)
        : null
    const installed = team?.state === 'installed' ? team : null
    return (
      <MobileConnectorTryIt
        connector="slack"
        subtitle={t('bots.slack.setup.isIn', '{{name}} is in Slack', { name: props.botName })}
        heading={t('bots.slack.setup.tryIt', 'Try it in any channel or DM')}
        prompt={{
          text: t('bots.slack.setup.preview.askPlain', '@{{name}} summarize this thread', {
            name: props.botName
          })
        }}
        more={
          installed ? (
            <ListRow
              leading={<ArrowUpRight size={18} color={colors.accentBlue} />}
              accent
              title={t('bots.slack.setup.openInSlack', 'Message it in Slack')}
              accessibilityRole="link"
              onPress={() =>
                openExternalLink(slackAppMessagesUrl(installed.appId, installed.teamId))
              }
            />
          ) : undefined
        }
        banner={props.banner}
        showToast={props.showToast}
        onDone={() => props.onInstalled(step.teamId)}
      />
    )
  }
  const header = (
    <SheetHeader
      title={
        props.inSlack && props.teamId === undefined
          ? t('bots.slack.setup.connectAnother', 'Connect another Slack workspace')
          : t('bots.slack.setup.connect', 'Connect Slack')
      }
      subtitle={t('bots.setup.for', 'for {{name}}', { name: props.botName })}
      leading={{ label: t('bots.slack.setup.cancel', 'Cancel'), onPress: props.onClose }}
      trailing={
        tokenStep
          ? {
              label: tokenStep.unsure
                ? t('bots.slack.reconnect.continue', 'Continue')
                : tokenStep.reconnect
                  ? t('bots.slack.setup.reconnectShort', 'Reconnect')
                  : t('bots.slack.setup.createShort', 'Create'),
              disabled: !canCreate,
              onPress: () => send(trimmed)
            }
          : undefined
      }
    />
  )
  const mark = <MobileConnectorLogo source="slack" size={28} />
  const body = (() => {
    switch (step.kind) {
      case 'checking':
        return <MobileStateView loading title={t('bots.slack.setup.checking', 'Checking Slack…')} />
      case 'setting-up':
        return (
          <MobileStateView
            loading
            title={t('bots.slack.setup.settingUp', 'Setting up your Slack app…')}
          />
        )
      case 'token':
        return (
          <>
            <SettingsSection
              first
              separatorInset={LIST_LEADING_INSET}
              footer={
                step.reconnect
                  ? step.unsure
                    ? t(
                        'bots.slack.reconnect.whyNeeded',
                        'Orca has no working Slack token for this workspace.'
                      )
                    : t(
                        'bots.slack.reconnect.stopped',
                        'Slack stopped accepting the token {{host}} uses.',
                        { host: props.hostName }
                      )
                  : t(
                      'bots.slack.token.kept',
                      'Orca Cloud keeps this token encrypted, so your next bots in this workspace need one click.'
                    )
              }
            >
              <ListRow
                leading={<StepNumber n={1} />}
                title={t('bots.slack.token.open', 'Get config token')}
                subtitle={t(
                  'bots.slack.token.step1',
                  'In Slack app settings, find “Your App Configuration Tokens” and choose Generate Token.'
                )}
                subtitleLines={3}
                accessory={<ArrowUpRight size={17} color={colors.textSecondary} />}
                accessibilityRole="link"
                onPress={() => openExternalLink(SLACK_APPS_URL)}
              />
              <ListRow
                leading={<StepNumber n={2} />}
                title={t('bots.slack.token.step2Title', 'Pick the workspace')}
                subtitle={t('bots.slack.token.step2', 'Select the workspace for your bot.')}
              />
              <ListRow
                leading={<StepNumber n={3} />}
                title={t('bots.slack.token.step3Title', 'Paste the Refresh Token')}
                subtitle={t('bots.slack.token.step3', 'Copy the Refresh Token and paste it below.')}
              />
              <TextField
                style={styles.tokenRow}
                accessibilityLabel={t('bots.slack.token.label', 'Configuration refresh token')}
                value={token}
                onChangeText={change}
                placeholder={TOKEN_PLACEHOLDER}
                secureTextEntry
                monospace
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="off"
                trailing={
                  <MobileBotTextButton
                    label={t('bots.slack.token.paste', 'Paste')}
                    disabled={!props.online}
                    onPress={() =>
                      void clipboard
                        .readText()
                        .then(take)
                        .catch(() => {})
                    }
                  />
                }
              />
            </SettingsSection>
            {accessPasted || step.error ? (
              <SettingsNote error>
                {accessPasted
                  ? t(
                      'bots.slack.token.accessPasted',
                      'That is the Access Token. Copy the Refresh Token, the one next to it.'
                    )
                  : step.error}
              </SettingsNote>
            ) : null}
          </>
        )
      case 'ready':
        return (
          <SettingsSection
            first
            title={t('bots.slack.setup.readyTitle', 'Your Slack app is ready')}
            footer={t(
              'bots.slack.setup.readyDetail',
              'Approve it in Slack to finish. If your workspace needs an admin to approve new apps, {{name}} joins once they do.',
              { name: props.botName }
            )}
          >
            <ListRow
              leading={<ArrowUpRight size={18} color={colors.accentBlue} />}
              accent
              title={t('bots.slack.setup.approve', 'Approve in Slack')}
              subtitle={
                step.opened ? t('bots.slack.setup.waiting', 'Waiting for Slack…') : undefined
              }
              accessory={
                step.opened ? (
                  <ActivityIndicator size="small" color={colors.textSecondary} />
                ) : undefined
              }
              accessibilityRole="link"
              disabled={!props.online}
              onPress={setup.approve}
            />
          </SettingsSection>
        )
      case 'pick':
        return (
          <SlackPickStep
            client={props.client}
            hostBots={props.hostBots}
            teamIds={step.teamIds}
            online={props.online}
            onPick={setup.setUp}
            onAnother={setup.pasteToken}
          />
        )
      case 'expired':
      case 'other-user':
        return (
          <SlackProblemStep
            kind={step.kind}
            teamId={step.teamId}
            client={props.client}
            hostBots={props.hostBots}
            botName={props.botName}
            hostName={props.hostName}
            online={props.online}
            onNewLink={() => setup.setUp(step.teamId)}
          />
        )
      case 'uncertain':
        return (
          <>
            <SettingsNote>
              {t(
                'bots.slack.setup.uncertain',
                'Slack may have created an app named {{name}} that Orca cannot use. Delete it in Slack app settings if it is there, then set up again.',
                { name: props.botName }
              )}
            </SettingsNote>
            <SettingsSection>
              <ListRow
                title={t(
                  'bots.slack.setup.uncertainChecked',
                  'I checked Slack: there is no such app, or I deleted it'
                )}
                wrapTitle
                selected={checked}
                accessibilityRole="checkbox"
                onPress={() => setChecked((value) => !value)}
              />
              <ListRow
                title={t('bots.slack.setup.again', 'Set up again')}
                accent
                disabled={!checked || !props.online}
                onPress={() => setup.setUp(step.teamId)}
              />
            </SettingsSection>
          </>
        )
      case 'failed':
        return (
          <MobileStateView
            iconElement={mark}
            title={slackErrorMessage(step.code, props.hostName, t)}
            action={
              props.online
                ? { label: t('bots.slack.setup.retry', 'Try again'), onPress: setup.retry }
                : null
            }
          />
        )
    }
  })()
  return (
    <>
      {header}
      {props.banner}
      {body}
    </>
  )
}

const stylesSheet = themedStyleSheet(() => ({
  // The token is the steps' last row: no box of its own, its text under the steps' titles.
  tokenRow: {
    borderWidth: 0,
    borderRadius: 0,
    backgroundColor: 'transparent',
    outlineWidth: 0,
    minHeight: 48,
    paddingLeft: LIST_LEADING_INSET,
    paddingRight: LIST_ROW_PADDING
  }
}))
