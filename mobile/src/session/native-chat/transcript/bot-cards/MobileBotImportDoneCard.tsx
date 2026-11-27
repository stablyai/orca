// What an import brought over (`orca bot import done`), as the desktop's card: each thing made, with Open
// where the phone has its page, what stayed in the old app, and when to turn the paused automations on.
import { Pressable, Text, View } from 'react-native'
import { Check, ChevronRight, CirclePause } from 'lucide-react-native'
import type { BotImportDone } from '../../../../../../src/shared/bots/bot-import-cards'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { colors, pressedStyle, spacing, typography } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import { scaledType } from '../messages/mobile-native-chat-message-styles'
import { MobileBotCardFrame, MobileBotCardMeta } from './MobileBotCardFrame'
import { useMobileBotCardHost } from './mobile-bot-card-host'
import { useBotPanelOpener } from '../../../../bots/bot-item-open'
import { MobileGoogleSetupOnComputer } from './MobileGoogleSetupCardParts'

type Created = BotImportDone['created'][number]

export function MobileBotImportDoneCard({
  done,
  fontScale
}: {
  done: BotImportDone
  fontScale: number
}): React.JSX.Element {
  const t = useMobileTranslation()
  const host = useMobileBotCardHost()
  // As the desktop: soul and memory open in the bot's Settings, where an older host has no panel to open.
  const panel = useBotPanelOpener(done.botId)
  const opener = (entry: Created): (() => void) | null => {
    const kind = entry.kind
    if (kind === 'automations') {
      return host?.openAutomations ?? null
    }
    return (kind === 'soul' || kind === 'memory') && panel
      ? () => panel.open({ settings: kind })
      : null
  }
  const meta = scaledType(typography.metaSize, fontScale, 4)
  return (
    <MobileBotCardFrame
      avatar={<Check size={14} color={colors.textMuted} />}
      heading={t('chat.botCards.importDone.heading', 'Import finished')}
      title={t('chat.botCards.importDone.title', '{{name}} came over from {{app}}', {
        name: done.name,
        app: done.app
      })}
      fontScale={fontScale}
    >
      {done.created.map((entry) => {
        const open = opener(entry)
        const text = (
          <View style={styles.text}>
            <Text style={[styles.what, scaledType(typography.bodySize, fontScale, 4)]}>
              {entry.what}
            </Text>
            {entry.detail ? <Text style={[styles.detail, meta]}>{entry.detail}</Text> : null}
          </View>
        )
        return open ? (
          <Pressable
            key={`${entry.kind}:${entry.what}`}
            accessibilityRole="button"
            onPress={open}
            style={({ pressed }) => [styles.row, pressed && pressedStyle]}
          >
            {text}
            <Text style={[styles.open, meta]}>{t('chat.botCards.importDone.open', 'Open')}</Text>
            <ChevronRight size={13} color={colors.textMuted} />
          </Pressable>
        ) : (
          <View key={`${entry.kind}:${entry.what}`} style={styles.row}>
            {text}
          </View>
        )
      })}
      <MobileBotCardMeta fontScale={fontScale} lines={4}>
        {done.stayed.length
          ? t(
              'chat.botCards.importDone.stayed',
              'Stayed in {{app}}: {{things}}. Nothing in {{app}} was changed.',
              { app: done.app, things: done.stayed.join(', ') }
            )
          : t('chat.botCards.importDone.unchanged', 'Nothing in {{app}} was changed.', {
              app: done.app
            })}
      </MobileBotCardMeta>
      {done.paused ? (
        <View style={styles.paused}>
          <CirclePause size={14} color={colors.statusAmber} />
          <Text style={[styles.pausedText, meta]}>
            {t(
              'chat.botCards.importDone.paused',
              'Automations are paused so nothing runs twice. Turn them on once the old bot is switched off in {{app}}.',
              { app: done.app }
            )}
          </Text>
        </View>
      ) : null}
      {!panel && done.created.some((entry) => entry.kind === 'soul' || entry.kind === 'memory') ? (
        <MobileGoogleSetupOnComputer
          text={t(
            'chat.botCards.importDone.soulOnComputer',
            'Open the soul and memory in Orca on your computer.'
          )}
          fontScale={fontScale}
        />
      ) : null}
    </MobileBotCardFrame>
  )
}

const styles = themedStyleSheet(() => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, minHeight: 36 },
  text: { flex: 1, minWidth: 0, gap: 1 },
  what: { color: colors.textPrimary, fontWeight: '600' },
  detail: { color: colors.textMuted },
  open: { color: colors.textPrimary, fontWeight: '600' },
  paused: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  pausedText: { flex: 1, color: colors.textSecondary }
}))
