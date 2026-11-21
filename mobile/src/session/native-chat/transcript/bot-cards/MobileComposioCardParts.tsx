// The pieces the phone's Composio setup cards share: what they act on, their heading and step, the
// host call with its busy state, and a line with its own leading mark.
import { useState, type ReactNode } from 'react'
import { Text, View } from 'react-native'
import type { ComposioSetupCardRef } from '../../../../../../src/shared/composio/composio-setup-card'
import { errorMessage } from '../../../../../../src/shared/errors/error-message'
import type { Translate } from '../../../../i18n/mobile-i18n'
import { colors, spacing, typography } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import type { RpcClient } from '../../../../transport/rpc/rpc-client-contract'
import { scaledType } from '../messages/mobile-native-chat-message-styles'
import type { MobileComposio } from './mobile-composio-store'

/** What a Composio card acts on: the chat's host, the bot, and its Composio as last read. */
export type MobileComposioScope = {
  client: RpcClient
  hostKey: string
  card: ComposioSetupCardRef
  botName: string
  view: MobileComposio
  fontScale: number
}

export function composioHeading(t: Translate): string {
  return t('chat.botCards.composio.heading', 'Composio')
}

export function composioStep(t: Translate, card: ComposioSetupCardRef): string | null {
  return card.step
    ? t('chat.botCards.composio.step', 'Step {{index}} of {{total}}', {
        index: card.step.index,
        total: card.step.total
      })
    : null
}

/** Runs one host call with the card's busy state and the host's refusal to show. */
export function useComposioCall(): {
  busy: boolean
  error: string | null
  setError: (error: string | null) => void
  run: (work: () => Promise<void>) => Promise<boolean>
} {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (work: () => Promise<void>): Promise<boolean> => {
    setBusy(true)
    setError(null)
    try {
      await work()
      return true
    } catch (caught) {
      setError(errorMessage(caught))
      return false
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, setError, run }
}

/** A row of the card's body with its own leading mark, as the waiting line. */
export function MobileComposioLine({
  leading,
  text,
  fontScale
}: {
  leading: ReactNode
  text: string
  fontScale: number
}): React.JSX.Element {
  return (
    <View style={lineStyles.line}>
      {leading}
      <Text style={[lineStyles.text, scaledType(typography.metaSize, fontScale)]}>{text}</Text>
    </View>
  )
}

const lineStyles = themedStyleSheet(() => ({
  line: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  text: { flex: 1, color: colors.textSecondary }
}))
