// A connector setup's last page, the desktop's ConnectorTryIt: how to ask the bot, ready to copy, then Done.
import type { ReactNode } from 'react'
import { Copy } from 'lucide-react-native'
import { BOT_CONNECTOR_NAMES } from '../../../../src/shared/bots/bot-templates'
import { ListRow } from '../../components/list/ListGroup'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useClipboardWriter } from '../../platform/clipboard/clipboard'
import { SettingsSection } from '../../settings/settings-screen-frame'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'

export function MobileConnectorTryIt(props: {
  /** Titled as the connector's own page, which Done opens. */
  connector: 'slack' | 'github' | 'linear'
  /** The desktop's done title, e.g. "Ada is on GitHub". */
  subtitle: string
  heading: string
  /** What to write; `copy` lands on the clipboard, none where pasting can't ask. */
  prompt: { text: string; copy?: string }
  footer?: string
  /** Rows after the prompt, e.g. Slack's Message it in Slack. */
  more?: ReactNode
  banner: ReactNode
  showToast: (message: string) => void
  /** Also what Back does: the setup's own back claim calls it. */
  onDone: () => void
}) {
  const colors = useMobileColors()
  const t = useMobileTranslation()
  const clipboard = useClipboardWriter()
  const { prompt, showToast } = props
  const copy = prompt.copy
  return (
    <>
      <SheetHeader
        title={BOT_CONNECTOR_NAMES[props.connector]}
        subtitle={props.subtitle}
        trailing={{ label: t('common.done', 'Done'), onPress: props.onDone }}
      />
      {props.banner}
      <SettingsSection first title={props.heading} footer={props.footer}>
        <ListRow
          title={prompt.text}
          wrapTitle
          accessory={copy ? <Copy size={17} color={colors.textSecondary} /> : undefined}
          accessibilityLabel={
            copy ? t('bots.setup.copyHowToAsk', 'Copy {{text}}', { text: copy }) : undefined
          }
          onPress={
            copy
              ? () =>
                  void clipboard.writeText(copy).then(
                    () => showToast(t('common.copied', 'Copied')),
                    () => showToast(t('bots.settings.copyFailed', 'Couldn’t copy'))
                  )
              : undefined
          }
        />
        {props.more}
      </SettingsSection>
    </>
  )
}
