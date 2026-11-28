// The ::orca-webhook card: the hook's URL, masked, with Copy fetching the key-bearing one from the bot's host. Only in the hook's own
// bot's chats; anywhere else, the line that says where the URL is. Rotating stays in Settings.
import { useContext, useEffect, useState } from 'react'
import { Text, View } from 'react-native'
import { Copy, Webhook } from 'lucide-react-native'
import {
  webhookCardShows,
  webhookStatusFact,
  type WebhookStatusFact
} from '../../../../../../src/shared/bots/webhook-card-view'
import type { WebhookAdapterId } from '../../../../../../src/shared/connector-webhook-contract'
import type { NativeChatBotCardValues } from '../../../../../../src/shared/native-chat/bot-cards/native-chat-bot-card-kind'
import { webhookCardFallbackText } from '../../../../../../src/shared/webhook-card-fallback'
import { useHostBotById } from '../../../../bots/host-bot-store'
import type { Translate } from '../../../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { useClipboardWriter } from '../../../../platform/clipboard/clipboard'
import { useNow } from '../../../../hooks/use-now'
import { commentRelativeTime } from '../../../../source-control/review/pull-request/comments/pr-comment-relative-time'
import { typography } from '../../../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../../../theme/themed-styles'
import { MobileNativeChatBotIdentityContext } from '../../mobile-native-chat-bot-identity'
import { scaledType } from '../messages/mobile-native-chat-message-styles'
import { MobileNativeChatNoticePill } from '../notices/MobileNativeChatNoticePill'
import { toolStylesSheet } from '../tool-results/mobile-native-chat-tool-styles'
import { mobileWebhookCardSay } from './mobile-bot-card-copy'
import { useMobileBotCardHost } from './mobile-bot-card-host'
import { webhookCardRead } from './mobile-bot-card-operations'
import { copyPhoneWebhookUrl } from '../../../../bots/webhooks/mobile-webhook-url-copy'
import { MobileBotCardActions, MobileBotCardFrame, MobileBotCardMeta } from './MobileBotCardFrame'
import { useMobileColors } from '../../../../theme/use-mobile-color-scheme'

const URL_KEY_MASK = '••••••••'

type HookRead =
  | { status: 'loading' }
  | { status: 'failed' }
  | {
      status: 'ready'
      hook: {
        botId: string
        url: string
        automationName: string
        state: 'pending' | 'live' | 'paused' | 'orphaned'
        adapter: WebhookAdapterId | null
        lastCall: { at: number; signatureValid: boolean } | null
      }
    }

/** A hook's status beside its title, in words. */
export function mobileWebhookStatus(fact: WebhookStatusFact, now: number, t: Translate): string {
  switch (fact.kind) {
    case 'paused':
      return t('chat.botCards.webhook.paused', 'Paused')
    case 'orphaned':
      return t('chat.botCards.webhook.orphaned', 'Not connected')
    case 'pending':
      return t('chat.botCards.webhook.pending', 'Setting up')
    case 'noCalls':
      return t('chat.botCards.webhook.noCalls', 'No calls yet')
    case 'lastCall':
      return t('chat.botCards.webhook.lastCall', 'Last call {{ago}}', {
        ago: commentRelativeTime(new Date(fact.at).toISOString(), now, t)
      })
  }
}

export function MobileBotWebhookCard({
  directive,
  fontScale = 1
}: {
  directive: NativeChatBotCardValues['webhook']
  fontScale?: number
}): React.JSX.Element {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const toolStyles = useThemedStyles(toolStylesSheet)
  const t = useMobileTranslation()
  const say = mobileWebhookCardSay(t)
  const host = useMobileBotCardHost()
  const client = host?.client ?? null
  const chatBotId = useContext(MobileNativeChatBotIdentityContext)?.botId ?? null
  const clipboard = useClipboardWriter()
  // "Last call 4m ago" moves on while the card is open.
  const now = useNow(60_000)
  const [read, setRead] = useState<HookRead>({ status: 'loading' })
  const [copy, setCopy] = useState<'idle' | 'busy' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    if (!client) {
      return
    }
    let live = true
    void webhookCardRead
      .request(client, { hookId: directive.hookId })
      .then((response) => {
        const hook = webhookCardRead.interpret(response)
        if (live) {
          setRead({
            status: 'ready',
            hook: {
              ...hook,
              adapter: hook.adapter ?? null,
              lastCall: hook.lastCall ?? null
            }
          })
        }
      })
      .catch(() => live && setRead({ status: 'failed' }))
    return () => {
      live = false
    }
  }, [client, directive.hookId])
  const hook = read.status === 'ready' ? read.hook : null
  const hookBot = useHostBotById(hook?.botId ?? '')
  const shows = webhookCardShows(read.status, chatBotId, hook?.botId ?? null)
  const text = [styles.line, scaledType(typography.bodySize, fontScale)]
  if (shows === 'failed' || shows === 'elsewhere' || !hook) {
    if (shows === 'loading') {
      return (
        <MobileBotCardFrame
          avatar={<Webhook size={14} color={colors.textMuted} />}
          title={say('title')}
          fontScale={fontScale}
        />
      )
    }
    return (
      <Text style={text}>
        {webhookCardFallbackText(
          hook && hookBot ? { automationName: hook.automationName, botName: hookBot.name } : null
        )}
      </Text>
    )
  }
  // The shown URL is masked; Copy carries the key, as on the computer.
  const copyUrl = () => {
    if (!client) {
      return
    }
    setCopy('busy')
    void copyPhoneWebhookUrl(client, directive.hookId, clipboard).then(
      (copied) => setCopy(copied.kind === 'copied' ? 'copied' : 'failed'),
      () => setCopy('failed')
    )
  }
  return (
    <MobileBotCardFrame
      avatar={<Webhook size={14} color={colors.textMuted} />}
      heading={say('starts', { automation: hook.automationName })}
      title={say('title')}
      meta={
        <MobileBotCardMeta fontScale={fontScale}>
          {mobileWebhookStatus(webhookStatusFact(hook), now, t)}
        </MobileBotCardMeta>
      }
      fontScale={fontScale}
      testID={`bot-webhook-card:${directive.hookId}`}
    >
      <View style={toolStyles.codeBox}>
        <Text selectable style={[toolStyles.codeText, scaledType(typography.metaSize, fontScale)]}>
          {`${hook.url}/${URL_KEY_MASK}`}
        </Text>
      </View>
      <MobileBotCardActions>
        <MobileNativeChatNoticePill
          label={
            copy === 'copied'
              ? t('chat.botCards.webhook.copied', 'Copied')
              : copy === 'failed'
                ? t('chat.botCards.webhook.copyFailed', 'Retry copy')
                : t('chat.botCards.webhook.copyUrl', 'Copy URL')
          }
          Icon={Copy}
          disabled={copy === 'busy'}
          onPress={copyUrl}
        />
      </MobileBotCardActions>
    </MobileBotCardFrame>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  line: { color: colors.textPrimary }
}))
