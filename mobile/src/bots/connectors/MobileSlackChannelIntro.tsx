// The bot's Slack channel intro switch, as the desktop's BotSlackChannelIntro: one value for the bot,
// shown on each Slack workspace's page.
import { botSlackApps } from '../../../../src/shared/bot-types'
import { ListRow } from '../../components/list/ListGroup'
import { MobileSwitch } from '../../components/controls/MobileSwitch'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { SettingsSection } from '../../settings/settings-screen-frame'
import type { PhoneBot } from '../host-bots-operations'

export function MobileSlackChannelIntro(props: {
  bot: PhoneBot
  online: boolean
  onChange: (on: boolean) => void
}) {
  const t = useMobileTranslation()
  const { bot } = props
  const title = t('bots.slack.channelIntro.title', 'Intro when added to a channel')
  const subtitle =
    botSlackApps(bot).length > 1
      ? t(
          'bots.slack.channelIntro.detailEvery',
          'When someone adds {{name}} to a channel, it posts a message there saying how to ask it. This setting applies to every Slack workspace {{name}} is in.',
          { name: bot.name }
        )
      : t(
          'bots.slack.channelIntro.detail',
          'When someone adds {{name}} to a channel, it posts a message there saying how to ask it.',
          { name: bot.name }
        )
  return (
    <SettingsSection title={t('bots.slack.channelIntro.caption', 'In channels')}>
      <ListRow
        title={title}
        subtitle={subtitle}
        disabled={!props.online}
        accessory={
          <MobileSwitch
            accessibilityLabel={title}
            accessibilityHint={subtitle}
            value={bot.slackChannelHello !== false}
            disabled={!props.online}
            onValueChange={props.onChange}
          />
        }
      />
    </SettingsSection>
  )
}
