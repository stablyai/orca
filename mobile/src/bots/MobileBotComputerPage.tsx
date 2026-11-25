// Where the bot runs, read-only: its computer, the Orca account that computer runs as, and its folder.
import { useEffect, useState, type ReactNode } from 'react'
import { Pressable } from 'react-native'
import { CircleUserRound, Copy, Folder, Laptop } from 'lucide-react-native'
import { ListRow } from '../components/list/ListGroup'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useClipboardWriter } from '../platform/clipboard/clipboard'
import { SettingsSection } from '../settings/settings-screen-frame'
import { colors, feedback, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { readOrcaAccount } from './new-bot-host-reads'

export function MobileBotComputerPage(props: {
  client: RpcClient | null
  online: boolean
  hostName: string
  folderPath: string | null
  banner: ReactNode
  showToast: (message: string) => void
  onBack: { label: string; onPress: () => void }
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const clipboard = useClipboardWriter()
  const { client, online, folderPath } = props
  // Undefined while checking; null when the host can't say.
  const [account, setAccount] = useState<{ state: string; email?: string } | null | undefined>(
    undefined
  )
  useEffect(() => {
    if (!client || !online) {
      return
    }
    let live = true
    void readOrcaAccount(client).then((answer) => {
      if (live) {
        setAccount(answer)
      }
    })
    return () => {
      live = false
    }
  }, [client, online])
  // The desktop's line for a server's account: nothing when Orca Cloud isn't set up or can't be read.
  const accountLine =
    account === undefined
      ? online
        ? t('bots.settings.accountChecking', 'Checking…')
        : undefined
      : !account || account.state === 'unconfigured'
        ? undefined
        : account.state === 'signed-in'
          ? account.email
          : account.state === 'signed-out'
            ? t('bots.settings.signedOut', 'Signed out of Orca')
            : t('bots.settings.signInChanged', 'Orca sign-in changed')
  const icon = (Icon: typeof Laptop) => <Icon size={18} color={colors.textSecondary} />
  return (
    <>
      <SheetHeader title={t('bots.settings.computer', 'Computer')} onBack={props.onBack} />
      {props.banner}
      <SettingsSection
        first
        footer={t(
          'bots.settings.computerFoot',
          'Its connectors, tools and files live on {{host}}.',
          {
            host: props.hostName
          }
        )}
      >
        <ListRow
          leading={icon(Laptop)}
          title={props.hostName}
          subtitle={t(
            'bots.settings.computerDetail',
            'Runs this bot’s chats, tools and automations'
          )}
        />
        <ListRow
          leading={icon(CircleUserRound)}
          title={t('bots.settings.orcaAccount', 'Orca account')}
          value={accountLine}
        />
        {folderPath ? (
          <ListRow
            leading={icon(Folder)}
            title={t('bots.settings.folder', 'Folder')}
            subtitle={folderPath}
            accessory={
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('bots.settings.copyPath', 'Copy path')}
                hitSlop={8}
                style={({ pressed }) => [styles.copy, pressed && styles.pressed]}
                onPress={() =>
                  void clipboard.writeText(folderPath).then(
                    () => props.showToast(t('bots.settings.pathCopied', 'Path copied')),
                    () => props.showToast(t('bots.settings.copyFailed', 'Couldn’t copy'))
                  )
                }
              >
                <Copy size={17} color={colors.textSecondary} />
              </Pressable>
            }
          />
        ) : null}
      </SettingsSection>
    </>
  )
}

const styles = themedStyleSheet(() => ({
  copy: { padding: spacing.xs },
  pressed: { opacity: feedback.pressedOpacity }
}))
