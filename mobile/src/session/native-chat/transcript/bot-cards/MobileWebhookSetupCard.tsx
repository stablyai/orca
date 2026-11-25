// A webhook automation's setup card in its chat, as on the computer: Copy URL up front, the key and a
// sample call one tap away. Drawn in place of the saved row, so the URL is never folded away.
import { useContext, useEffect, useRef, useState } from 'react'
import { AppState, Text, View } from 'react-native'
import { Check, ChevronDown, ChevronRight, Webhook } from '../../../../components/icons/app-icons'
import {
  webhookAdapterName,
  webhookStatusFact
} from '../../../../../../src/shared/bots/webhook-card-view'
import type { WebhookAdapterId } from '../../../../../../src/shared/connector-webhook-contract'
import { webhookSample, WEBHOOK_WRITE } from '../../../../bots/webhooks/mobile-webhook-operations'
import {
  webhookErrorMessage,
  webhookReplyErrorCode
} from '../../../../bots/webhooks/mobile-webhook-copy'
import { randomV4Uuid } from '../../../../platform/random-v4-uuid'
import { copyPhoneWebhookUrl } from '../../../../bots/webhooks/mobile-webhook-url-copy'
import { startHostBotRefresh } from '../../../../bots/host-bot-refresh'
import { useNow } from '../../../../hooks/use-now'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { useClipboardWriter } from '../../../../platform/clipboard/clipboard'
import { colors, spacing, typography } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import { MobileNativeChatBotIdentityContext } from '../../mobile-native-chat-bot-identity'
import { scaledType } from '../messages/mobile-native-chat-message-styles'
import { MobileNativeChatNoticePill } from '../notices/MobileNativeChatNoticePill'
import { useMobileBotCardHost } from './mobile-bot-card-host'
import { webhookCardRead } from './mobile-bot-card-operations'
import { MobileBotCardActions, MobileBotCardFrame, MobileBotCardMeta } from './MobileBotCardFrame'
import { mobileWebhookStatus } from './MobileBotWebhookCard'
import { MobileGoogleSetupReceipt } from './MobileGoogleSetupCardParts'

const MASK = '••••••••'

type Hook = {
  state: 'pending' | 'live' | 'paused' | 'orphaned'
  adapter: WebhookAdapterId | null
  lastCall: { at: number; signatureValid: boolean } | null
}

// Hooks whose URL was copied here this session, so the receipt survives the row scrolling away.
const copiedHooks = new Set<string>()

export function MobileWebhookSetupCard({
  hookId,
  name,
  fontScale
}: {
  hookId: string
  /** The automation's name. */
  name: string
  fontScale: number
}): React.JSX.Element {
  const t = useMobileTranslation()
  const client = useMobileBotCardHost()?.client ?? null
  const botName = useContext(MobileNativeChatBotIdentityContext)?.name ?? ''
  const clipboard = useClipboardWriter()
  const [hook, setHook] = useState<Hook | null>(null)
  const [copied, setCopied] = useState(() => copiedHooks.has(hookId))
  const [busy, setBusy] = useState(false)
  // The last action's outcome, said under the card: a refusal, or that a sample went out.
  const [note, setNote] = useState<{ text: string; failed: boolean } | null>(null)
  const [open, setOpen] = useState(false)
  const [readFailed, setReadFailed] = useState(false)
  const called = hook?.state === 'live' && hook.lastCall !== null
  // "Last call 4m ago" moves on only once there is a call.
  const now = useNow(60_000, called)
  // Raised when the host or hook changes and on unmount: an answer for an older scope copies nothing.
  const keyScope = useRef(0)
  useEffect(() => {
    keyScope.current += 1
    return () => {
      keyScope.current += 1
    }
  }, [client, hookId])
  // Until the hook is live it reads again on the host's notices, so Copy URL turns on by itself.
  const waiting = hook === null || hook.state === 'pending'
  useEffect(() => {
    if (!client || !waiting) {
      return
    }
    let live = true
    let replied = false
    const read = (): void => {
      void webhookCardRead
        .request(client, { hookId })
        .then((reply) => webhookCardRead.interpret(reply))
        .then(
          (answer) => {
            replied = true
            if (live) {
              setReadFailed(false)
              setHook({
                state: answer.state,
                adapter: answer.adapter ?? null,
                lastCall: answer.lastCall ?? null
              })
            }
          },
          // A failed read leaves Copy URL on, whose tap says why; the refresh keeps trying meanwhile.
          () => {
            if (live) {
              setReadFailed(true)
            }
          }
        )
    }
    const stop = startHostBotRefresh({
      client,
      appState: AppState,
      refresh: read,
      listed: () => replied
    })
    return () => {
      live = false
      stop()
    }
  }, [client, hookId, waiting])

  // Copy or send, one at a time; a refusal or a sent sample is said under the card.
  const settle = (work: Promise<{ text: string; failed: boolean } | null>): void => {
    setBusy(true)
    setNote(null)
    void work
      .then(setNote, () =>
        setNote({ text: webhookErrorMessage('failed', botName, t), failed: true })
      )
      .finally(() => setBusy(false))
  }
  const copy = (what: 'url' | 'key'): void => {
    if (!client) {
      return
    }
    const scope = keyScope.current
    settle(
      copyPhoneWebhookUrl(client, hookId, clipboard, () => scope === keyScope.current, what).then(
        (result) => {
          if (result.kind === 'refused') {
            return { text: webhookErrorMessage(result.code, botName, t), failed: true }
          }
          if (result.kind === 'dropped') {
            return null
          }
          if (what === 'key') {
            return { text: t('bots.webhooks.copiedKey', 'Key copied'), failed: false }
          }
          copiedHooks.add(hookId)
          setCopied(true)
          return null
        }
      )
    )
  }
  const sendSample = (): void => {
    if (!client) {
      return
    }
    settle(
      webhookSample
        .request(client, { hookId, operationId: randomV4Uuid() }, WEBHOOK_WRITE)
        .then((reply) =>
          reply.ok
            ? { text: t('bots.webhooks.sample.sent', 'Sample call sent'), failed: false }
            : {
                text: webhookErrorMessage(webhookReplyErrorCode(reply.error.code), botName, t),
                failed: true
              }
        )
    )
  }

  const pending = hook === null ? !readFailed : hook.state === 'pending'
  const status = called
    ? { label: t('chat.botCards.webhookSetup.on', 'On'), on: true }
    : hook && hook.state !== 'live'
      ? { label: mobileWebhookStatus(webhookStatusFact(hook), now, t), on: false }
      : null
  const meta = scaledType(typography.metaSize, fontScale, 4)
  return (
    <View style={styles.wrap}>
      <MobileBotCardFrame
        avatar={<Webhook size={14} color={colors.textMuted} />}
        heading={t('chat.botCards.webhookSetup.heading', 'Set up a webhook')}
        trailing={
          status ? (
            <Text style={[status.on ? styles.on : styles.muted, meta]}>{`· ${status.label}`}</Text>
          ) : null
        }
        title={name}
        meta={
          <MobileBotCardMeta fontScale={fontScale}>
            {called && hook
              ? mobileWebhookStatus(webhookStatusFact(hook), now, t)
              : t('chat.botCards.webhookSetup.hint', 'Point your service at this URL')}
          </MobileBotCardMeta>
        }
        fontScale={fontScale}
        testID={`webhook-setup-card:${hookId}`}
      >
        <MobileBotCardActions>
          <MobileNativeChatNoticePill
            label={
              pending
                ? t('chat.botCards.webhookSetup.gettingUrl', 'Getting the URL…')
                : copied
                  ? t('chat.botCards.webhook.copied', 'Copied')
                  : t('chat.botCards.webhook.copyUrl', 'Copy URL')
            }
            Icon={copied && !pending ? Check : undefined}
            primary={!called}
            disabled={pending || busy || !client}
            onPress={() => copy('url')}
          />
          {pending || !hook ? null : (
            <MobileNativeChatNoticePill
              label={t('chat.botCards.webhookSetup.keyAndSecret', 'Key and signing secret')}
              Icon={open ? ChevronDown : ChevronRight}
              onPress={() => setOpen((value) => !value)}
            />
          )}
        </MobileBotCardActions>
        {open && hook ? (
          <View>
            <Field
              label={t('chat.botCards.webhookSetup.headerKey', 'Header key')}
              value={`Bearer ${MASK}`}
              action={t('chat.botCards.webhookSetup.copy', 'Copy')}
              onPress={busy ? undefined : () => copy('key')}
              fontScale={fontScale}
            />
            <Field
              label={t('chat.botCards.webhookSetup.signingSecret', 'Signing secret')}
              value={
                hook.adapter
                  ? webhookAdapterName(hook.adapter)
                  : t('chat.botCards.webhookSetup.noSecret', 'None')
              }
              fontScale={fontScale}
            />
            <Field
              label={t('chat.botCards.webhookSetup.sampleCall', 'Sample call')}
              value={t('chat.botCards.webhookSetup.sampleNote', 'Starts a real run')}
              action={t('chat.botCards.webhookSetup.send', 'Send')}
              onPress={busy || hook.state !== 'live' ? undefined : sendSample}
              fontScale={fontScale}
            />
          </View>
        ) : null}
        {note ? (
          <Text style={[note.failed ? styles.error : styles.muted, meta]}>{note.text}</Text>
        ) : null}
      </MobileBotCardFrame>
      {copied ? (
        <MobileGoogleSetupReceipt
          text={t('chat.botCards.webhookSetup.copiedReceipt', '✓ URL copied')}
          fontScale={fontScale}
        />
      ) : null}
    </View>
  )
}

function Field({
  label,
  value,
  action,
  onPress,
  fontScale
}: {
  label: string
  value: string
  action?: string
  onPress?: () => void
  fontScale: number
}): React.JSX.Element {
  const meta = scaledType(typography.metaSize, fontScale, 4)
  return (
    <View style={styles.field}>
      <Text style={[styles.fieldLabel, meta]}>{label}</Text>
      <Text style={[styles.fieldValue, meta]}>{value}</Text>
      {action ? (
        <Text
          accessibilityRole="button"
          accessibilityState={onPress ? undefined : { disabled: true }}
          suppressHighlighting
          onPress={onPress}
          style={[styles.fieldAction, !onPress && styles.disabled, meta]}
        >
          {action}
        </Text>
      ) : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  wrap: { gap: spacing.xs },
  on: { color: colors.statusGreen },
  muted: { color: colors.textMuted },
  error: { color: colors.statusRed },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 36,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle
  },
  fieldLabel: { width: 100, color: colors.textMuted },
  fieldValue: { flex: 1, color: colors.textPrimary },
  fieldAction: { color: colors.textPrimary, fontWeight: '600' },
  disabled: { opacity: 0.4 }
}))
