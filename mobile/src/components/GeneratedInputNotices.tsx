import { memo, useEffect, useState } from 'react'
import * as z from 'zod'
import type { GeneratedAgentInputNotice } from '../../../src/shared/generated-agent-input-notice'
import { generatedInputAgentName } from '../../../src/shared/generated-agent-input-notice'
import { GENERATED_INPUT_RECOVERY_RUNTIME_CAPABILITY } from '../../../src/shared/terminal/runtime-policy/terminal-runtime-capabilities'
import {
  createGeneratedInputNoticeFeed,
  generatedInputNoticesPageSchema
} from '../../../src/shared/generated-input-notice-feed'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import type { RpcClient } from '../transport/rpc-client'
import { useClipboardWriter } from '../platform/clipboard'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { HostRouteNoticeBanner } from './HostRouteNoticeBanner'
import {
  MoreGeneratedInputNoticesRow,
  OlderGeneratedInputNotices
} from './OlderGeneratedInputNotices'
import { useRelayHosts } from '../worktree/relay-hosts-feed'
import { scopeRpcClientToExecutionHost } from '../transport/execution-host-scoped-rpc-client'
import { useHostStatusGates } from '../transport/host-status-gates'
import { GeneratedInputNoticeList } from './generated-input-notice-list'

const dismissNotice = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'terminal.dismiss-generated-input-notice',
    method: 'terminal.dismissGeneratedInputNotice',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('dismissed', z.object({ dismissed: z.literal(true) }))
  })
)
const readNoticePage = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'terminal.generated-input-notices-page',
    method: 'terminal.generatedInputNotices.page',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('page', generatedInputNoticesPageSchema)
  })
)

/** One notice's banner. Memoized on its notice record, which the indexed view keeps by identity,
 *  so a change to another notice never re-renders it. */
const GeneratedInputNoticeBanner = memo(function GeneratedInputNoticeBanner({
  notice,
  client
}: {
  notice: GeneratedAgentInputNotice
  client: RpcClient
}) {
  const t = useMobileTranslation()
  const clipboard = useClipboardWriter()
  const agent = generatedInputAgentName(notice.agent)
  return (
    <HostRouteNoticeBanner
      message={generatedInputNoticeMessage(t, notice, agent)}
      tone="failure"
      action={{
        label:
          notice.submitted === false
            ? t('agentPrompt.copyNotes', 'Copy notes')
            : t('agentPrompt.copy', 'Copy prompt'),
        onPress: () => {
          void clipboard.writeText(notice.text).catch(() => {})
        }
      }}
      onDismiss={() => {
        // The owning runtime removes it for every client; this view waits for that change.
        void dismissNotice
          .request(client, { id: notice.id })
          .then((reply) => {
            dismissNotice.interpret(reply)
          })
          .catch(() => {})
      }}
    />
  )
})

/** Notices of the one runtime `client` reaches: the paired desktop, or a server workspace's host. */
export function GeneratedInputNotices({
  client,
  capabilities
}: {
  client: RpcClient | null
  capabilities: readonly string[]
}) {
  const [view, setView] = useState(() => ({
    notices: new GeneratedInputNoticeList(),
    revision: 0
  }))
  const capable = capabilities.includes(GENERATED_INPUT_RECOVERY_RUNTIME_CAPABILITY)
  useEffect(() => {
    if (!client || !capable) {
      return
    }
    // This subscription's view; each change hands React a new wrapper around it.
    const notices = new GeneratedInputNoticeList()
    const feed = createGeneratedInputNoticeFeed({
      // A refused page throws; the feed then keeps what it has rather than deleting anything.
      readPage: async (from) =>
        readNoticePage.interpret(await readNoticePage.request(client, from ?? {})),
      onSnapshot: (snapshot, session) => {
        notices.replace(snapshot, session)
        setView({ notices, revision: notices.revision })
      },
      onDelta: (delta, session) => {
        const changed =
          delta.kind === 'added' ? notices.add(delta.notice, session) : notices.dismiss(delta.id)
        if (changed) {
          setView({ notices, revision: notices.revision })
        }
      }
    })
    const unsubscribe = client.subscribe(
      'terminal.generatedInputNotices.subscribe',
      null,
      feed.receive
    )
    return () => {
      feed.stop()
      unsubscribe()
      setView({ notices: new GeneratedInputNoticeList(), revision: 0 })
    }
  }, [client, capable])
  const [expanded, setExpanded] = useState(false)
  const t = useMobileTranslation()
  if (!client || !capable) {
    return null
  }
  // The newest notice shows as a banner; the rest wait behind one row, expanded on request.
  const newest = view.notices.at(0)
  const olderNotes = view.notices.promptCount - Number(newest?.notice.submitted !== false) === 0
  const olderCount = view.notices.size - 1
  if (!newest) {
    return null
  }
  return (
    <>
      <GeneratedInputNoticeBanner key={newest.key} notice={newest.notice} client={client} />
      {olderCount > 0 ? (
        <MoreGeneratedInputNoticesRow
          label={moreNoticesLabel(t, olderCount, olderNotes)}
          expanded={expanded}
          onToggle={() => setExpanded((open) => !open)}
        />
      ) : null}
      {olderCount > 0 && expanded ? (
        <OlderGeneratedInputNotices
          items={view.notices}
          revision={view.revision}
          keyOf={(shown) => shown.key}
          render={(shown) => <GeneratedInputNoticeBanner notice={shown.notice} client={client} />}
        />
      ) : null}
    </>
  )
}

/** The row's count: notes wording when every hidden notice is an unsubmitted draft. */
function moreNoticesLabel(
  t: ReturnType<typeof useMobileTranslation>,
  count: number,
  notes: boolean
): string {
  if (notes) {
    return count === 1
      ? t('agentPrompt.moreNotesNotSent_one', '{{count}} more notes not sent', { count })
      : t('agentPrompt.moreNotesNotSent_other', '{{count}} more notes not sent', { count })
  }
  return count === 1
    ? t('agentPrompt.morePromptsNotSent_one', '{{count}} more prompt not sent', { count })
    : t('agentPrompt.morePromptsNotSent_other', '{{count}} more prompts not sent', { count })
}

/** Each reachable server's notices, read, copied and dismissed on that server through this
 *  desktop's relay: one feed per host, shown on the host surface whichever screen is open. */
export function PairedServerGeneratedInputNotices({ client }: { client: RpcClient | null }) {
  const hosts = useRelayHosts(client)
  if (!client) {
    return null
  }
  return (
    <>
      {(hosts ?? [])
        .filter((host) => host.relay === 'ready')
        .map((host) => (
          <ServerGeneratedInputNotices key={host.hostId} client={client} hostId={host.hostId} />
        ))}
    </>
  )
}

function ServerGeneratedInputNotices({
  client,
  hostId
}: {
  client: RpcClient
  hostId: `runtime:${string}`
}) {
  const scoped = scopeRpcClientToExecutionHost(client, hostId)
  const gates = useHostStatusGates({ hostId: undefined, client: scoped, connState: 'connected' })
  return <GeneratedInputNotices client={scoped} capabilities={gates.hostCapabilities} />
}

/** An unsubmitted draft keeps the existing notes wording; a prompt says prompt. */
function generatedInputNoticeMessage(
  t: ReturnType<typeof useMobileTranslation>,
  notice: GeneratedAgentInputNotice,
  agent: string
): string {
  const unconfirmed = notice.certainty === 'unconfirmed'
  if (notice.submitted === false) {
    return unconfirmed
      ? t(
          'agentPrompt.notesUnconfirmed',
          '{{agent}} may have received part of your notes. Check its terminal before sending again.',
          { agent }
        )
      : t(
          'agentPrompt.notesNotSent',
          "Your notes weren't sent to {{agent}}. Answer any dialog in its terminal, then paste your notes.",
          { agent }
        )
  }
  return unconfirmed
    ? t(
        'agentPrompt.deliveryUnconfirmed',
        '{{agent}} may have received part of your prompt. Check its terminal before sending again.',
        { agent }
      )
    : t(
        'agentPrompt.notSent',
        "Your prompt wasn't sent to {{agent}}. Answer any dialog in its terminal, then paste your prompt.",
        { agent }
      )
}
