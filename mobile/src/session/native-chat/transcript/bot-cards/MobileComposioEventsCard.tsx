// The card that sends a Composio trigger's events to one of the bot's webhooks, as the desktop's
// ComposioEventsCard: one tap when the project sends its events nowhere yet, Replace when they go
// somewhere else, or by-hand steps (copy the address, paste it in Composio, Done).
import { useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import { Copy, ExternalLink, Webhook } from '../../../../components/icons/app-icons'
import { COMPOSIO_PAGES } from '../../../../../../src/shared/composio/composio-apps'
import { errorMessage } from '../../../../../../src/shared/errors/error-message'
import { startHostBotRefresh } from '../../../../bots/host-bot-refresh'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { useClipboardWriter } from '../../../../platform/clipboard/clipboard'
import { openExternalLink } from '../../../../platform/external-links/external-link'
import { colors } from '../../../../theme/mobile-theme'
import { MobileNativeChatNoticePill } from '../notices/MobileNativeChatNoticePill'
import { MobileBotCardActions } from './MobileBotCardFrame'
import { webhookKeyReveal } from './mobile-bot-card-operations'
import {
  composioEventsByHand,
  composioEventsStatusRead,
  composioSetUpEvents,
  type MobileComposioEventsStatus
} from './mobile-composio-operations'
import {
  composioHeading,
  useComposioCall,
  type MobileComposioScope
} from './MobileComposioCardParts'
import {
  MobileGoogleSetupError,
  MobileGoogleSetupFrame,
  MobileGoogleSetupMuted,
  MobileGoogleSetupNotes,
  MobileGoogleSetupReceipt
} from './MobileGoogleSetupCardParts'

type EventsView =
  | { status: 'loading' }
  | ({ status: 'ready' } & MobileComposioEventsStatus)
  | { status: 'error'; message: string }

function ByHandSteps({
  scope,
  hookId,
  triggerName,
  busy,
  onDone
}: {
  scope: MobileComposioScope
  /** The project's events hook, not the card's own. */
  hookId: string
  triggerName: string
  busy: boolean
  onDone: () => void
}): React.JSX.Element {
  const t = useMobileTranslation()
  const clipboard = useClipboardWriter()
  const [copy, setCopy] = useState<'idle' | 'busy' | 'copied' | 'failed'>('idle')
  const { client, botName, fontScale } = scope
  // The address carries the hook's key, fetched on the owner's tap and never shown.
  const copyUrl = () => {
    setCopy('busy')
    void webhookKeyReveal
      .request(client, { hookId })
      .then((response) => clipboard.writeText(webhookKeyReveal.interpret(response).url))
      .then(
        () => setCopy('copied'),
        () => setCopy('failed')
      )
  }
  return (
    <>
      <MobileGoogleSetupNotes
        notes={[
          t('chat.botCards.composio.byHandCopy', 'Copy {{bot}}’s address.', { bot: botName }),
          t(
            'chat.botCards.composio.byHandPaste',
            'In Composio, open your project’s settings, then Webhooks, and paste it.'
          )
        ]}
        fontScale={fontScale}
      />
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
        <MobileNativeChatNoticePill
          label={t('chat.botCards.composio.byHandOpen', 'Open Composio')}
          Icon={ExternalLink}
          onPress={() => openExternalLink(COMPOSIO_PAGES.settings)}
        />
        <MobileNativeChatNoticePill
          label={t('chat.botCards.composio.byHandDone', 'Done')}
          primary
          disabled={busy}
          onPress={onDone}
        />
      </MobileBotCardActions>
      <MobileGoogleSetupMuted
        text={t(
          'chat.botCards.composio.byHandDoneNote',
          'Orca then turns on {{trigger}} and saves Composio’s signing secret.',
          { trigger: triggerName }
        )}
        fontScale={fontScale}
      />
    </>
  )
}

export function MobileComposioEventsCard({
  scope
}: {
  scope: MobileComposioScope
}): React.JSX.Element | null {
  const t = useMobileTranslation()
  const { client, card, botName, fontScale } = scope
  const { busy, error, setError, run } = useComposioCall()
  const [view, setView] = useState<EventsView>({ status: 'loading' })
  // The owner's pick on this phone; unpicked, an unsigned events hook means by hand was chosen before.
  const [picked, setPicked] = useState<'by-hand' | 'buttons' | null>(null)
  // Raised per read; a reply older than the last read started is dropped.
  const asked = useRef(0)
  const { hookId, trigger, botId } = card
  const slug = trigger?.slug
  useEffect(() => {
    if (!hookId || !slug) {
      return
    }
    let live = true
    let replied = false
    const read = () => {
      const ticket = ++asked.current
      void composioEventsStatusRead
        .request(client, { botId, hookId, trigger: slug })
        .then((response) => composioEventsStatusRead.interpret(response))
        .then(
          (status): EventsView => ({ status: 'ready', ...status }),
          (caught: unknown): EventsView => ({ status: 'error', message: errorMessage(caught) })
        )
        .then((next) => {
          // Each read asks Composio, so a refusal waits for the next notice rather than the poll.
          replied = true
          if (live && ticket === asked.current) {
            setView(next)
          }
        })
    }
    // The refresh reads once as it starts.
    const stop = startHostBotRefresh({
      client,
      appState: AppState,
      refresh: read,
      listed: () => replied,
      interest: () => ({ botId, kinds: ['settings', 'bot'] })
    })
    return () => {
      live = false
      stop()
    }
  }, [client, botId, hookId, slug])
  if (!hookId || !trigger) {
    return null
  }
  const reread = async () => {
    const ticket = ++asked.current
    const status = composioEventsStatusRead.interpret(
      await composioEventsStatusRead.request(client, { botId, hookId, trigger: trigger.slug })
    )
    if (ticket === asked.current) {
      setView({ status: 'ready', ...status })
    }
  }
  const setUp = (how: 'new' | 'replace' | { byHand: string }) =>
    void run(async () => {
      composioSetUpEvents.interpret(
        await composioSetUpEvents.request(client, {
          botId,
          hookId,
          trigger: trigger.slug,
          ...(trigger.config ? { config: trigger.config } : {}),
          ...(how === 'replace' ? { replace: true } : {}),
          ...(typeof how === 'object' ? { byHand: how.byHand } : {})
        })
      )
      await reread()
    })
  const byHand = () =>
    void run(async () => {
      composioEventsByHand.interpret(await composioEventsByHand.request(client, { botId, hookId }))
      await reread()
      setPicked('by-hand')
    })
  const ready = view.status === 'ready' ? view : null
  const done = ready?.target === 'ours' && ready.on
  const other = ready?.target === 'other'
  const choseByHand = picked ? picked === 'by-hand' : ready?.ingress?.signed === false
  const byHandHookId = (choseByHand && ready?.ingress?.hookId) || null
  const shownError = error ?? (view.status === 'error' ? view.message : null)
  return (
    <MobileGoogleSetupFrame
      titleLines={2}
      avatar={<Webhook size={14} color={colors.textMuted} />}
      heading={composioHeading(t)}
      title={t('chat.botCards.composio.eventsTitle', 'Have Composio call {{bot}} on {{trigger}}', {
        bot: botName,
        trigger: trigger.name
      })}
      meta={
        other
          ? t(
              'chat.botCards.composio.eventsReplaceNote',
              'Your Composio project already sends its events to another address. Setting this up sends them here instead, and that address stops getting them.'
            )
          : t(
              'chat.botCards.composio.eventsOneAddressNote',
              'Orca turns on {{trigger}} for your sign-in. Your Composio project’s events come to Orca at one address, and each goes to the bot it’s for.',
              { trigger: trigger.name }
            )
      }
      fontScale={fontScale}
    >
      <MobileGoogleSetupError text={shownError} fontScale={fontScale} />
      {done ? (
        <MobileGoogleSetupReceipt
          text={t('chat.botCards.composio.eventsDone', '✓ Set up')}
          fontScale={fontScale}
        />
      ) : byHandHookId ? (
        <>
          <ByHandSteps
            scope={scope}
            hookId={byHandHookId}
            triggerName={trigger.name}
            busy={busy}
            onDone={() => setUp({ byHand: byHandHookId })}
          />
          <MobileGoogleSetupReceipt
            text={t('chat.botCards.composio.eventsChosenByHand', 'Doing it in Composio')}
            onChange={() => {
              setError(null)
              setPicked('buttons')
            }}
            fontScale={fontScale}
          />
        </>
      ) : (
        <MobileBotCardActions>
          <MobileNativeChatNoticePill
            label={
              other
                ? t('chat.botCards.composio.eventsReplace', 'Replace and set up')
                : t('chat.botCards.composio.eventsSetUp', 'Set it up')
            }
            primary
            disabled={busy || view.status === 'loading'}
            onPress={() => setUp(other ? 'replace' : 'new')}
          />
          <MobileNativeChatNoticePill
            label={t('chat.botCards.composio.eventsByHand', 'Manual setup')}
            disabled={busy}
            onPress={byHand}
          />
        </MobileBotCardActions>
      )}
    </MobileGoogleSetupFrame>
  )
}
