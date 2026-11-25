// Settings › Connectors › Webhooks: the desktop's BotWebhooksCard as pages inside the bot's settings. Hooks are
// made and their filters changed in chat; here the owner reads, copies, pauses, rotates, signs and deletes.
import { useEffect, useState, type ReactNode } from 'react'
import { Webhook, Plus } from '../../components/icons/app-icons'
import { webhookStatusFact } from '../../../../src/shared/bots/webhook-card-view'
import { ListRow } from '../../components/list/ListGroup'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { ConfirmContent } from '../../components/sheets/ConfirmModal'
import { useNow } from '../../hooks/use-now'
import type { Translate } from '../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useBackClaim } from '../../navigation/use-back-claim'
import { randomV4Uuid } from '../../platform/random-v4-uuid'
import { isHostNotConnectedError } from '../../query/host-query-errors'
import { SettingsSection } from '../../settings/settings-screen-frame'
import { mobileWebhookStatus } from '../../session/native-chat/transcript/bot-cards/MobileBotWebhookCard'
import { colors } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { RpcResponse } from '../../transport/rpc/rpc-wire-types'
import { MobileBotWebhookDetail } from './MobileBotWebhookDetail'
import {
  MobileBotWebhookRotate,
  MobileBotWebhookSecret,
  useWaitingWebhookSecret
} from './MobileBotWebhookKeyPages'
import {
  webhookAgo,
  webhookErrorMessage,
  webhookHostLine,
  webhookReplyErrorCode,
  webhookResultsTo,
  type WebhookErrorCode
} from './mobile-webhook-copy'
import {
  webhookDelete,
  webhookPause,
  webhookRotate,
  webhookSample,
  webhookSecretSet,
  WEBHOOK_WRITE,
  type PhoneWebhook
} from './mobile-webhook-operations'
import { usePhoneWebhooks } from './use-phone-webhooks'

function lastCallLower(at: number | undefined, now: number, t: Translate): string {
  return at
    ? t('bots.webhooks.lastCallLower', 'last call {{ago}}', { ago: webhookAgo(at, now, t) })
    : t('bots.webhooks.noCallsLower', 'no calls yet')
}

/** A hook's state alone, for a row whose caption already says when it was last called. */
function hookState(hook: PhoneWebhook, t: Translate): string {
  return hook.state === 'live'
    ? t('bots.webhooks.status.on', 'On')
    : mobileWebhookStatus(webhookStatusFact(hook), 0, t)
}

type SettingsContext = {
  client: RpcClient | null
  routeBot: { reads: number; bot: { id: string; name: string } }
  showToast: (message: string, durationMs?: number) => void
  online: boolean
  hostName: string
  onAskInChat?: ((draft: string) => void) | null
}

/** The Connectors row (once the bot has a hook) and, while open, the page that replaces Connectors. */
export function useMobileBotWebhookSettings(
  settings: SettingsContext,
  banner: ReactNode
): { row: ReactNode; page: ReactNode } {
  const { bot } = settings.routeBot
  const webhooks = usePhoneWebhooks(settings.client, bot.id, settings.routeBot.reads)
  const [open, setOpen] = useState(false)
  const { read } = webhooks
  // Like the desktop's row: none until the host answers with a hook.
  if (read.status !== 'ready' || read.value.length === 0) {
    if (open && read.status === 'ready') {
      setOpen(false)
    }
    return { row: null, page: null }
  }
  if (!open) {
    return { row: <WebhooksRow hooks={read.value} onOpen={() => setOpen(true)} />, page: null }
  }
  return {
    row: null,
    page: (
      <WebhooksPage
        client={settings.client}
        botName={bot.name}
        hooks={read.value}
        refreshError={read.refreshError}
        version={webhooks.version}
        changed={webhooks.changed}
        showToast={settings.showToast}
        online={settings.online}
        hostName={settings.hostName}
        banner={banner}
        onBack={() => setOpen(false)}
        onAskInChat={settings.onAskInChat ?? null}
      />
    )
  }
}

/** The desktop's Webhooks row face: how many hooks, the last call, and one status. */
function WebhooksRow(props: { hooks: readonly PhoneWebhook[]; onOpen: () => void }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const now = useNow(30_000)
  const { hooks } = props
  const lastAt = Math.max(0, ...hooks.map((hook) => hook.lastCall?.at ?? 0))
  const count = t('bots.webhooks.hookCount', '{{count}} hooks', {
    count: hooks.length,
    defaultValue_one: '{{count}} hook'
  })
  const status = hooks.every((hook) => hook.state === 'paused')
    ? t('bots.webhooks.status.paused', 'Paused')
    : lastAt > 0
      ? t('bots.webhooks.status.receiving', 'Receiving')
      : t('bots.webhooks.status.noCalls', 'No calls yet')
  return (
    <ListRow
      leading={<Webhook size={20} color={colors.textSecondary} />}
      title={t('bots.webhooks.name', 'Webhooks')}
      subtitle={`${count} · ${lastCallLower(lastAt, now, t)}`}
      value={status}
      navigates
      onPress={props.onOpen}
    />
  )
}

type HookStep = 'detail' | 'delete' | 'rotate' | 'secret'

type WebhooksPageProps = {
  client: RpcClient | null
  botName: string
  hooks: readonly PhoneWebhook[]
  /** The latest read failed: actions wait, and the reason shows under the header. */
  refreshError: WebhookErrorCode | null
  /** Bumps after each owner action, so the calls read again too. */
  version: number
  changed: () => void
  showToast: (message: string, durationMs?: number) => void
  /** The phone reaches the host; off, every action waits. */
  online: boolean
  hostName: string
  banner: ReactNode
  onBack: () => void
  /** Puts a draft in the bot's Home Chat; null while no chat shows. */
  onAskInChat: ((draft: string) => void) | null
}

/** The bot's hooks, and one hook as a page with its ⋯ actions. */
function WebhooksPage(props: WebhooksPageProps) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const now = useNow(30_000)
  const { changed } = props
  // Like the desktop's 30 s fallback, for what botsChanged doesn't cover, such as a call the cloud holds.
  useEffect(changed, [changed, now])
  const [open, setOpen] = useState<{ hookId: string; step: HookStep } | null>(null)
  // A made secret the owner left before it arrived shows until they're done with it.
  const waiting = useWaitingWebhookSecret(props.hooks)
  const shown = waiting ? { hookId: waiting, step: 'secret' as const } : open
  const hook = shown
    ? props.hooks.find((candidate) => candidate.hookId === shown.hookId)
    : undefined
  // The signing secret page claims Back itself, so it can hold a made secret.
  useBackClaim(
    shown?.step === 'secret' && hook
      ? null
      : () => {
          if (open && hook) {
            setOpen(open.step === 'detail' ? null : { hookId: open.hookId, step: 'detail' })
          } else {
            props.onBack()
          }
          return true
        }
  )
  if (shown && hook) {
    return (
      <HookPages
        {...props}
        hook={hook}
        step={shown.step}
        // A reply landing after the owner moved to another hook leaves that hook's page alone.
        setStep={(step) =>
          setOpen((current) =>
            current?.hookId !== hook.hookId ? current : step ? { hookId: hook.hookId, step } : null
          )
        }
      />
    )
  }
  return (
    <>
      <SheetHeader
        title={t('bots.webhooks.name', 'Webhooks')}
        onBack={{
          label: t('bots.connectors.back', 'Back to Connectors'),
          onPress: props.onBack
        }}
      />
      {props.banner}
      <SettingsSection first>
        {props.hooks.map((candidate) => (
          <ListRow
            key={candidate.hookId}
            title={candidate.automationName}
            subtitle={`${webhookResultsTo(candidate.resultsTo, t)} · ${lastCallLower(candidate.lastCall?.at, now, t)}`}
            subtitleLines={1}
            value={hookState(candidate, t)}
            navigates
            onPress={() => setOpen({ hookId: candidate.hookId, step: 'detail' })}
          />
        ))}
        {props.onAskInChat ? (
          <ListRow
            key="add"
            title={t('bots.webhooks.addInChat', 'Add in chat')}
            leading={<Plus size={18} color={colors.textMuted} />}
            onPress={() =>
              props.onAskInChat?.(t('bots.webhooks.setUpDraft', 'Set up a webhook that '))
            }
          />
        ) : null}
      </SettingsSection>
    </>
  )
}

function HookPages(
  props: WebhooksPageProps & {
    hook: PhoneWebhook
    step: HookStep
    setStep: (step: HookStep | null) => void
  }
) {
  const t = useMobileTranslation()
  const { client, hook, botName } = props
  const [busy, setBusy] = useState(false)
  const hostLine = props.refreshError
    ? (webhookHostLine(props.refreshError, botName, t) ??
      webhookErrorMessage(props.refreshError, botName, t))
    : webhookHostLine(hook.host, botName, t)
  const ready = props.online && !props.refreshError && hook.host === 'online'
  const back = () => props.setStep('detail')

  /** One owner action: a toast for its outcome, and every read again after a change. */
  const act = async (send: (client: RpcClient) => Promise<RpcResponse>, done: string | null) => {
    if (!client) {
      return null
    }
    setBusy(true)
    try {
      const reply = await send(client)
      if (!reply.ok) {
        props.showToast(webhookErrorMessage(webhookReplyErrorCode(reply.error.code), botName, t))
        return null
      }
      props.changed()
      if (done) {
        props.showToast(done)
      }
      return reply
    } catch (error) {
      props.showToast(
        isHostNotConnectedError(error)
          ? t('bots.items.write.offline', '{{host}} is offline.', { host: props.hostName })
          : webhookErrorMessage('failed', botName, t)
      )
      return null
    } finally {
      setBusy(false)
    }
  }
  const operation = { hookId: hook.hookId }
  const once = () => ({ hookId: hook.hookId, operationId: randomV4Uuid() })

  if (props.step === 'delete') {
    return (
      <ConfirmContent
        {...(hook.deletesAutomation
          ? {
              title: t(
                'bots.webhooks.delete.withAutomation.title',
                'Delete “{{automation}}” and its webhook?',
                { automation: hook.automationName }
              ),
              message: t(
                'bots.webhooks.delete.withAutomation.note',
                "Nothing else starts this automation, so it's deleted with its run history. The webhook's URL stops working, and calls still waiting are cancelled."
              ),
              confirmLabel: t('bots.webhooks.delete.withAutomation.confirm', 'Delete both')
            }
          : {
              title: t('bots.webhooks.delete.title', 'Delete the webhook for “{{automation}}”?', {
                automation: hook.automationName
              }),
              message: t(
                'bots.webhooks.delete.note',
                'Its URL stops working, and calls still waiting are cancelled. A new webhook gets a new URL.'
              ),
              confirmLabel: t('bots.webhooks.delete.confirm', 'Delete webhook')
            })}
        destructive
        onCancel={back}
        onConfirm={() =>
          void act(
            (c) => webhookDelete.request(c, operation, WEBHOOK_WRITE),
            t('bots.webhooks.delete.done', 'Webhook deleted')
          ).then((reply) => reply && props.setStep(null))
        }
      />
    )
  }
  if (props.step === 'rotate') {
    return (
      <MobileBotWebhookRotate
        hook={hook}
        busy={busy}
        disabled={!ready}
        onCancel={back}
        onRotate={async (stopNow) => {
          const reply = await act(
            (c) => webhookRotate.request(c, { ...once(), stopNow }, WEBHOOK_WRITE),
            t('bots.webhooks.rotate.done', 'Key rotated. Copy the new URL.')
          )
          if (reply) {
            back()
          }
        }}
      />
    )
  }
  if (props.step === 'secret') {
    return (
      <MobileBotWebhookSecret
        hook={hook}
        busy={busy}
        disabled={!ready}
        showToast={props.showToast}
        onDone={back}
        onSave={async (adapter, secret) => {
          const params = { ...once(), adapter }
          const reply = await act(
            (c) =>
              webhookSecretSet.request(
                c,
                secret === null ? { ...params, generate: true } : { ...params, secret },
                WEBHOOK_WRITE
              ),
            secret === null ? null : t('bots.webhooks.secret.saved', 'Signing secret saved')
          )
          return reply ? (webhookSecretSet.interpret(reply).secret ?? null) : false
        }}
      />
    )
  }
  return (
    <MobileBotWebhookDetail
      client={client}
      hook={hook}
      botName={botName}
      version={props.version}
      banner={props.banner}
      hostLine={hostLine}
      ready={ready}
      busy={busy}
      showToast={props.showToast}
      onAskInChat={props.onAskInChat}
      onBack={() => props.setStep(null)}
      onOpen={props.setStep}
      onPause={() =>
        void act(
          (c) =>
            webhookPause.request(
              c,
              { ...operation, paused: hook.state !== 'paused' },
              WEBHOOK_WRITE
            ),
          hook.state === 'paused'
            ? t('bots.webhooks.resumed', 'Webhook resumed')
            : t('bots.webhooks.paused', 'Webhook paused')
        )
      }
      onSample={() =>
        void act(
          (c) => webhookSample.request(c, once(), WEBHOOK_WRITE),
          t('bots.webhooks.sample.sent', 'Sample call sent')
        )
      }
    />
  )
}
