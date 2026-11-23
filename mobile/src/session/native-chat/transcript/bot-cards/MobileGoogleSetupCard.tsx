// A Google setup card in a bot's chat on the phone, drawn from the bot's setup run as the computer's
// is (GoogleSetupChatCard), so both show the same and follow the run as the bot moves it.
import { Text } from 'react-native'
import {
  isNewestGoogleSetupCard,
  type GoogleSetupCardRef
} from '../../../../../../src/shared/google/google-setup-card'
import { useHostBotById } from '../../../../bots/host-bot-store'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { colors, typography } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../../theme/use-mobile-color-scheme'
import { scaledType } from '../messages/mobile-native-chat-message-styles'
import { useMobileBotCardHost } from './mobile-bot-card-host'
import { useMobileGoogleSetup } from './mobile-google-setup-store'
import type { MobileGoogleSetupScope } from './MobileGoogleSetupCardParts'
import {
  MobileGoogleSetupAccountCard,
  MobileGoogleSetupPathCard,
  MobileGoogleSetupServicesCard
} from './MobileGoogleSetupChoiceCards'
import {
  MobileGoogleSetupConnectCard,
  MobileGoogleSetupConnectedCard
} from './MobileGoogleSetupConnectCards'
import {
  MobileGoogleSetupProgressCard,
  MobileGoogleSetupStepCard
} from './MobileGoogleSetupProgressCards'

export function MobileGoogleSetupCard({
  card,
  fallback,
  fontScale
}: {
  card: GoogleSetupCardRef
  /** The host's line, for a bot or run this phone can't read. */
  fallback: string
  fontScale: number
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const host = useMobileBotCardHost()
  const bot = useHostBotById(card.botId)
  // Only for a bot this phone lists: the host refuses a read for any other.
  const setup = useMobileGoogleSetup(
    bot ? (host?.client ?? null) : null,
    host?.hostKey ?? null,
    card.botId,
    card.runId
  )
  const run = setup?.run
  const line = (text: string) => (
    <Text style={[styles.line, scaledType(typography.bodySize, fontScale)]}>{text}</Text>
  )
  if (!host || !bot || !run) {
    return line(fallback)
  }
  if (run.id !== card.runId) {
    return line(t('chat.botCards.google.ended', 'This Google setup ended.'))
  }
  const scope: MobileGoogleSetupScope = {
    client: host.client,
    hostKey: host.hostKey,
    botId: bot.id,
    botName: bot.name,
    run,
    blocker: setup.blocker,
    fontScale
  }
  // Ordered by the copy number Orca wrote, so scrolling older history in never moves the buttons.
  const newest = isNewestGoogleSetupCard(run, card)
  switch (card.card) {
    case 'path':
      return <MobileGoogleSetupPathCard scope={scope} />
    case 'account':
      return <MobileGoogleSetupAccountCard scope={scope} />
    case 'services':
      return <MobileGoogleSetupServicesCard scope={scope} />
    case 'progress':
      return <MobileGoogleSetupProgressCard scope={scope} newest={newest} />
    case 'step':
      return card.step ? (
        <MobileGoogleSetupStepCard scope={scope} step={card.step} newest={newest} />
      ) : (
        line(fallback)
      )
    case 'connect':
      return <MobileGoogleSetupConnectCard scope={scope} newest={newest} />
    case 'connected':
      return <MobileGoogleSetupConnectedCard scope={scope} />
  }
}

const styles = themedStyleSheet(() => ({
  line: { color: colors.textMuted }
}))
