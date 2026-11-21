// One hook as a page: the desktop's HookDetail fields and Recent calls, with its action bar moved into ⋯.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { View } from 'react-native'
import {
  Ellipsis,
  KeyRound,
  Pause,
  Play,
  RefreshCw,
  Send,
  Trash2
} from '../../components/icons/app-icons'
import { webhookStatusFact } from '../../../../src/shared/bots/webhook-card-view'
import { ListGroup, ListRow, SectionHeader } from '../../components/list/ListGroup'
import { NavBarButton } from '../../components/nav-bar/NavBarButton'
import { NativeMenu } from '../../components/menu/NativeMenu'
import type { ActionSheetAction } from '../../components/sheets/ActionSheetModal'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { SheetPrimaryButton } from '../../components/sheets/SheetPrimaryButton'
import { useNow } from '../../hooks/use-now'
import { getUiIntlLocale } from '../../i18n/ui-intl-locale'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useClipboardWriter } from '../../platform/clipboard/clipboard'
import { SettingsNote, SettingsSection } from '../../settings/settings-screen-frame'
import { webhookKeyReveal } from '../../session/native-chat/transcript/bot-cards/mobile-bot-card-operations'
import { mobileWebhookStatus } from '../../session/native-chat/transcript/bot-cards/MobileBotWebhookCard'
import { spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { MobileBotTextButton } from '../MobileBotTextButton'
import {
  webhookCallLine,
  webhookChecks,
  webhookErrorMessage,
  webhookOnlyWhen,
  webhookReplyErrorCode,
  webhookStarts
} from './mobile-webhook-copy'
import type { PhoneWebhook, PhoneWebhookCall } from './mobile-webhook-operations'
import { usePhoneWebhookCalls } from './use-phone-webhooks'

/** Owner writes fail at once while the phone can't reach the host, instead of waiting for it. */
export const WEBHOOK_WRITE = { failWhenDisconnected: true } as const

const URL_KEY_MASK = '••••••••'
// Closed lists show this many; Show all reveals the rest the host returned.
const SHOWN_CALLS = 5

type DetailProps = {
  client: RpcClient | null
  hook: PhoneWebhook
  botName: string
  version: number
  banner: ReactNode
  /** Why the host can't act on the hook now, if it can't. */
  hostLine: string | null
  ready: boolean
  busy: boolean
  showToast: (message: string) => void
  onAskInChat: ((draft: string) => void) | null
  onBack: () => void
  onOpen: (step: 'delete' | 'rotate' | 'secret') => void
  onPause: () => void
  onSample: () => void
}

export function MobileBotWebhookDetail(props: DetailProps) {
  const t = useMobileTranslation()
  const now = useNow(30_000)
  const { hook, ready, busy } = props
  const clipboard = useClipboardWriter()
  const [copying, setCopying] = useState(false)
  const paused = hook.state === 'paused'
  // The shown URL is masked; Copy fetches the key-bearing one and never shows it.
  // A reveal answering after the page closed or the key rotated copies nothing.
  const keyScope = useRef(0)
  useEffect(() => {
    keyScope.current += 1
    return () => {
      keyScope.current += 1
    }
  }, [hook.hookId, hook.keyGeneration])
  const copyUrl = async () => {
    if (!props.client) {
      return
    }
    setCopying(true)
    const scope = keyScope.current
    try {
      const reply = await webhookKeyReveal.request(
        props.client,
        { hookId: hook.hookId },
        WEBHOOK_WRITE
      )
      if (scope !== keyScope.current) {
        return
      }
      if (!reply.ok) {
        const code = webhookReplyErrorCode(reply.error.code)
        props.showToast(webhookErrorMessage(code, props.botName, t))
        return
      }
      await clipboard.writeText(webhookKeyReveal.interpret(reply).url)
      props.showToast(t('bots.webhooks.copiedUrl', 'URL copied'))
    } catch {
      props.showToast(t('bots.webhooks.copyFailed', 'Couldn’t copy. Try again.'))
    } finally {
      setCopying(false)
    }
  }
  const pauseLabel = paused
    ? t('bots.webhooks.resume', 'Resume')
    : t('bots.webhooks.pause', 'Pause')
  const { pick } = hook.filters
  const menuGroups: ActionSheetAction[][] = [
    [
      {
        label: t('bots.webhooks.sample.send', 'Send a sample call'),
        icon: Send,
        hint: t('bots.webhooks.sample.note', 'A sample starts a real run.'),
        disabled: !ready || busy || hook.state !== 'live',
        onPress: props.onSample
      },
      {
        label: pauseLabel,
        icon: paused ? Play : Pause,
        disabled: !ready || busy || hook.state === 'orphaned',
        onPress: props.onPause
      },
      {
        label: t('bots.webhooks.rotate.open', 'Rotate key…'),
        icon: RefreshCw,
        disabled: !ready,
        onPress: () => props.onOpen('rotate')
      },
      {
        label: hook.adapter
          ? t('bots.webhooks.secret.changeOpen', 'Change signing secret…')
          : t('bots.webhooks.secret.add', 'Add signing secret…'),
        icon: KeyRound,
        disabled: !ready,
        onPress: () => props.onOpen('secret')
      }
    ],
    [
      {
        label: t('bots.webhooks.delete.open', 'Delete hook…'),
        icon: Trash2,
        destructive: true,
        disabled: !ready || busy,
        onPress: () => props.onOpen('delete')
      }
    ]
  ]
  return (
    <>
      <SheetHeader
        title={hook.automationName}
        subtitle={mobileWebhookStatus(webhookStatusFact(hook), now, t)}
        onBack={{ label: t('bots.webhooks.back', 'Back to Webhooks'), onPress: props.onBack }}
        trailingButtons={
          <NativeMenu groups={menuGroups}>
            {(openMenu) => (
              <NavBarButton
                icon={Ellipsis}
                accessibilityLabel={t('bots.webhooks.more', 'More actions')}
                onPress={openMenu}
              />
            )}
          </NativeMenu>
        }
      />
      {props.banner}
      {props.hostLine ? <SettingsNote>{props.hostLine}</SettingsNote> : null}
      {hook.state === 'orphaned' ? (
        <SettingsNote>
          {t(
            'bots.webhooks.orphanedNote',
            '{{bot}}’s Orca no longer lists this automation, so calls aren’t run.',
            { bot: props.botName }
          )}
        </SettingsNote>
      ) : null}
      <SettingsSection>
        <ListRow
          title={t('bots.webhooks.url', 'URL')}
          subtitle={`${hook.url}/${URL_KEY_MASK}`}
          subtitleMono
          accessory={
            <MobileBotTextButton
              label={t('bots.webhooks.copy', 'Copy')}
              accessibilityLabel={t('bots.webhooks.copyUrl', 'Copy URL')}
              disabled={!ready || copying}
              onPress={() => void copyUrl()}
            />
          }
        />
        <ListRow
          title={t('bots.webhooks.checksLabel', 'Checks')}
          subtitle={webhookChecks(hook.adapter, t)}
        />
        <ListRow title={t('bots.webhooks.starts', 'Starts')} subtitle={webhookStarts(hook, t)} />
        <ListRow
          title={t('bots.webhooks.onlyWhen', 'Only when')}
          subtitle={webhookOnlyWhen(hook.filters, t)}
          subtitleLines={4}
          accessory={
            props.onAskInChat ? (
              <MobileBotTextButton
                label={t('bots.webhooks.editInChat', 'Edit in chat')}
                onPress={() =>
                  props.onAskInChat?.(
                    t('bots.webhooks.editDraft', 'Change when “{{automation}}” runs: ', {
                      automation: hook.automationName
                    })
                  )
                }
              />
            ) : undefined
          }
        />
        {pick && pick.length > 0 ? (
          <ListRow
            title={t('bots.webhooks.quotes', 'Quotes')}
            subtitle={pick.join(', ')}
            subtitleMono
          />
        ) : null}
      </SettingsSection>
      {paused ? (
        <View style={styles.primary}>
          <SheetPrimaryButton
            label={pauseLabel}
            icon={Play}
            disabled={!ready}
            busy={busy}
            onPress={props.onPause}
          />
        </View>
      ) : null}
      <RecentCalls
        client={props.client}
        hook={hook}
        botName={props.botName}
        version={props.version}
      />
    </>
  )
}

function callTime(row: PhoneWebhookCall): string {
  const at = row.kind === 'call' ? row.receivedAt : row.minute
  const format = new Intl.DateTimeFormat(getUiIntlLocale(), { hour: 'numeric', minute: '2-digit' })
  return format.format(at)
}

/** Recent calls: the cloud's verdict for each call, then what the bot's computer did with it. */
function RecentCalls(props: {
  client: RpcClient | null
  hook: PhoneWebhook
  botName: string
  version: number
}) {
  const t = useMobileTranslation()
  const read = usePhoneWebhookCalls(props.client, props.hook.hookId, props.version)
  const [showAll, setShowAll] = useState(false)
  const calls = read.status === 'ready' ? read.value : []
  const shown = showAll ? calls : calls.slice(0, SHOWN_CALLS)
  return (
    <>
      <SectionHeader
        title={t('bots.webhooks.recentCalls', 'Recent calls')}
        trailing={
          calls.length > SHOWN_CALLS ? (
            <MobileBotTextButton
              label={
                showAll
                  ? t('bots.webhooks.showFewer', 'Show fewer')
                  : t('bots.webhooks.showAll', 'Show all')
              }
              onPress={() => setShowAll((value) => !value)}
            />
          ) : undefined
        }
      />
      {read.status === 'failed' ? (
        <SettingsNote>{webhookErrorMessage(read.error, props.botName, t)}</SettingsNote>
      ) : read.status === 'ready' && calls.length === 0 ? (
        <SettingsNote>{t('bots.webhooks.noCalls', 'No calls yet.')}</SettingsNote>
      ) : shown.length > 0 ? (
        <ListGroup>
          {shown.map((row) => {
            const line = webhookCallLine(row, props.botName, props.hook.resultsTo, t)
            return (
              <ListRow
                key={row.kind === 'call' ? row.callId : `${row.kind}:${row.minute}`}
                title={line.label}
                subtitle={line.detail || undefined}
                subtitleLines={1}
                value={callTime(row)}
              />
            )
          })}
        </ListGroup>
      ) : null}
    </>
  )
}

const styles = themedStyleSheet(() => ({
  primary: { marginTop: spacing.lg }
}))
