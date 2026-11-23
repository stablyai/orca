// A connector setup's last page, the desktop's ConnectorTryIt and its Slack and GitHub previews: how to ask
// the bot, each ready to copy, then Done.
import type { ReactNode } from 'react'
import { Pressable, View } from 'react-native'
import { CircleUserRound, Copy } from '../../components/icons/app-icons'
import { BOT_CONNECTOR_NAMES } from '../../../../src/shared/bots/bot-templates'
import { ListRow } from '../../components/list/ListGroup'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { SheetPrimaryButton } from '../../components/sheets/SheetPrimaryButton'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useClipboardWriter } from '../../platform/clipboard/clipboard'
import { SettingsSection } from '../../settings/settings-screen-frame'
import { colors, feedback, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { MobileBotAvatar } from '../MobileBotAvatar'
import type { MobileBotAvatarSource } from '../host-bot-row-facts'

const AVATAR = 24

type TryItWay = {
  key: string
  title: string
  subtitle?: string
  /** Who says it, in the previews' sample exchange: a person, or the bot replying. */
  from?: 'person' | 'bot'
  /** What lands on the clipboard; none where pasting can't ask. */
  copy?: string
}

export function MobileConnectorTryIt(props: {
  /** Titled as the connector's own page, which Done opens. */
  connector: 'slack' | 'github' | 'linear'
  /** The desktop's done title, e.g. "Ada is on GitHub". */
  subtitle: string
  heading: string
  ways: readonly TryItWay[]
  note?: string
  /** The bot's picture, for a way `from` it. */
  avatar?: MobileBotAvatarSource
  banner: ReactNode
  /** Rows after the sample, e.g. Slack's Message it in Slack. */
  more?: ReactNode
  showToast: (message: string) => void
  /** Also what Back does: the setup's own back claim calls it. */
  onDone: () => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const clipboard = useClipboardWriter()
  const { showToast, onDone } = props
  const copy = (text: string) =>
    void clipboard.writeText(text).then(
      () => showToast(t('common.copied', 'Copied')),
      () => showToast(t('bots.settings.copyFailed', 'Couldn’t copy'))
    )
  return (
    <>
      <SheetHeader title={BOT_CONNECTOR_NAMES[props.connector]} subtitle={props.subtitle} />
      {props.banner}
      <SettingsSection first title={props.heading} footer={props.note}>
        {props.ways.map(({ copy: text, ...way }) => (
          <ListRow
            key={way.key}
            title={way.title}
            subtitle={way.subtitle}
            leading={
              way.from === 'bot' && props.avatar ? (
                <MobileBotAvatar avatar={props.avatar} size={AVATAR} />
              ) : way.from === 'person' ? (
                <CircleUserRound size={AVATAR} color={colors.textSecondary} strokeWidth={1.5} />
              ) : undefined
            }
            accessory={
              text ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t('bots.setup.copyHowToAsk', 'Copy {{text}}', {
                    text
                  })}
                  hitSlop={8}
                  style={({ pressed }) => [styles.copy, pressed && styles.pressed]}
                  onPress={() => copy(text)}
                >
                  <Copy size={17} color={colors.textSecondary} />
                </Pressable>
              ) : undefined
            }
          />
        ))}
      </SettingsSection>
      {props.more ? <SettingsSection>{props.more}</SettingsSection> : null}
      <View style={styles.action}>
        <SheetPrimaryButton label={t('common.done', 'Done')} onPress={onDone} />
      </View>
    </>
  )
}

const styles = themedStyleSheet(() => ({
  copy: { padding: spacing.xs },
  pressed: { opacity: feedback.pressedOpacity },
  action: { marginTop: spacing.lg }
}))
