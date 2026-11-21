// Connect Slack as a page inside the bot's settings: the desktop's BotSlackSetupDialog and SlackConfigTokenForm,
// for a phone. No hand-off (it needs the desktop's own Orca account) and no clipboard read on return: Paste
// stands in for it.
import { useEffect, useState, type ReactNode } from 'react'
import { ActivityIndicator, Text, View } from 'react-native'
import { ExternalLink } from '../../components/icons/app-icons'
import {
  SLACK_CONFIG_REFRESH_TOKEN_PREFIX,
  slackConfigTokenKind
} from '../../../../src/shared/connector-bot-slack-contract'
import { TextField } from '../../components/composer-input/TextField'
import { MobileStateView } from '../../components/feedback/MobileStateView'
import { ListRow } from '../../components/list/ListGroup'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { SheetPrimaryButton } from '../../components/sheets/SheetPrimaryButton'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useBackClaim } from '../../navigation/use-back-claim'
import { useClipboardReader } from '../../platform/clipboard/clipboard'
import { openExternalLink } from '../../platform/external-links/external-link'
import { SettingsNote, SettingsSection } from '../../settings/settings-screen-frame'
import { colors, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { MobileBotTextButton } from '../MobileBotTextButton'
import { MobileConnectorSourceIcon } from '../MobileConnectorSourceIcon'
import { slackErrorMessage } from './mobile-slack-copy'
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
  knownTeam: string | null
  slack: { view: PhoneSlackView; refresh: () => Promise<PhoneSlackView> }
  hostName: string
  online: boolean
  banner: ReactNode
  onClose: () => void
  /** Slack says it's installed: the workspace's page takes over. */
  onInstalled: (teamId: string) => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const setup = usePhoneSlackSetup({ ...props, t })
  const { step } = setup
  const [token, setToken] = useState('')
  const [accessPasted, setAccessPasted] = useState(false)
  const [checked, setChecked] = useState(false)
  const clipboard = useClipboardReader()
  useBackClaim(() => {
    props.onClose()
    return true
  })
  const { onInstalled } = props
  const installedTeam = step.kind === 'installed' ? step.teamId : null
  useEffect(() => {
    if (installedTeam) {
      onInstalled(installedTeam)
    }
  }, [installedTeam, onInstalled])

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
              label: tokenStep.reconnect
                ? t('bots.slack.setup.reconnectShort', 'Reconnect')
                : t('bots.slack.setup.createShort', 'Create'),
              disabled: !canCreate,
              onPress: () => send(trimmed)
            }
          : undefined
      }
    />
  )
  const mark = <MobileConnectorSourceIcon source="slack" size={28} />
  const body = (() => {
    switch (step.kind) {
      case 'checking':
        return <MobileStateView loading title={t('bots.slack.setup.checking', 'Checking Slack…')} />
      case 'setting-up':
      case 'installed':
        return (
          <MobileStateView
            loading
            title={t('bots.slack.setup.settingUp', 'Setting up your Slack app…')}
          />
        )
      case 'token':
        return (
          <>
            {step.reconnect ? (
              <SettingsNote>
                {t(
                  'bots.slack.setup.reconnect',
                  'Slack no longer accepts this workspace’s token. Paste a new one to reconnect.'
                )}
              </SettingsNote>
            ) : null}
            <SettingsSection first>
              <ListRow
                leading={<ExternalLink size={18} color={colors.textPrimary} />}
                title={t('bots.slack.token.open', 'Get config token')}
                accessibilityRole="link"
                onPress={() => openExternalLink(SLACK_APPS_URL)}
              />
            </SettingsSection>
            <SettingsSection>
              {[
                t(
                  'bots.slack.token.step1',
                  'In Slack app settings, find “Your App Configuration Tokens” and choose Generate Token.'
                ),
                t('bots.slack.token.step2', 'Select the workspace for your bot.'),
                t('bots.slack.token.step3', 'Copy the Refresh Token and paste it below.')
              ].map((line, index) => (
                <ListRow key={line} marker={String(index + 1)} title={line} wrapTitle />
              ))}
            </SettingsSection>
            <View style={styles.field}>
              <TextField
                label={t('bots.slack.token.label', 'Configuration refresh token')}
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
            </View>
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
            <SettingsNote>
              {t(
                'bots.slack.token.kept',
                'Orca Cloud keeps this token encrypted, so your next bots in this workspace need one click.'
              )}
            </SettingsNote>
          </>
        )
      case 'ready':
        return (
          <MobileStateView
            iconElement={mark}
            title={t('bots.slack.setup.readyTitle', 'Your Slack app is ready')}
            message={t(
              'bots.slack.setup.readyDetail',
              'Approve it in Slack to finish. If your workspace needs an admin to approve new apps, {{name}} joins once they do.',
              { name: props.botName }
            )}
          >
            <SheetPrimaryButton
              label={t('bots.slack.setup.approve', 'Approve in Slack')}
              icon={ExternalLink}
              disabled={!props.online}
              onPress={setup.approve}
            />
            {step.opened ? (
              <View style={styles.waiting}>
                <ActivityIndicator size="small" color={colors.textSecondary} />
                <Text style={styles.waitingText}>
                  {t('bots.slack.setup.waiting', 'Waiting for Slack…')}
                </Text>
              </View>
            ) : null}
          </MobileStateView>
        )
      case 'expired':
      case 'other-user':
        return (
          <MobileStateView
            iconElement={mark}
            title={
              step.kind === 'expired'
                ? t('bots.slack.setup.expired', 'The install link expired.')
                : t(
                    'bots.slack.setup.otherUser',
                    'Another Slack account approved it. Get a new link and approve as yourself.'
                  )
            }
            action={
              props.online
                ? {
                    label: t('bots.slack.setup.newLink', 'Get a new link'),
                    onPress: () => setup.setUp(step.teamId)
                  }
                : null
            }
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
            </SettingsSection>
            <View style={styles.field}>
              <SheetPrimaryButton
                label={t('bots.slack.setup.again', 'Set up again')}
                disabled={!checked || !props.online}
                onPress={() => setup.setUp(step.teamId)}
              />
            </View>
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

const styles = themedStyleSheet(() => ({
  field: { marginTop: spacing.lg },
  waiting: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    marginTop: spacing.lg
  },
  waitingText: { color: colors.textSecondary, fontSize: 13 }
}))
