import { useEffect, useState } from 'react'
import { z } from 'zod'
import type { GeneratedAgentInputNotice } from '../../../src/shared/generated-agent-input-notice'
import { generatedInputAgentName } from '../../../src/shared/generated-agent-input-notice'
import { GENERATED_INPUT_RECOVERY_RUNTIME_CAPABILITY } from '../../../src/shared/terminal-runtime-capabilities'
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

// Stacked workspace routes for one server each subscribe; a notice renders in the first only.
const claims = new Map<string, symbol>()

type Shown = { key: string; notice: GeneratedAgentInputNotice }

/** Notices of the one runtime `client` reaches: the paired desktop, or a server workspace's host. */
export function GeneratedInputNotices({
  client,
  capabilities
}: {
  client: RpcClient | null
  capabilities: readonly string[]
}) {
  const t = useMobileTranslation()
  const clipboard = useClipboardWriter()
  const [shown, setShown] = useState<Shown[]>([])
  const capable = capabilities.includes(GENERATED_INPUT_RECOVERY_RUNTIME_CAPABILITY)
  useEffect(() => {
    if (!client || !capable) {
      return
    }
    const owner = Symbol('generated-input-notices')
    const release = (): void => {
      for (const [key, holder] of claims) {
        if (holder === owner) {
          claims.delete(key)
        }
      }
    }
    const feed = createGeneratedInputNoticeFeed({
      // A refused page throws; the feed then keeps what it has rather than deleting anything.
      readPage: async (from) =>
        readNoticePage.interpret(await readNoticePage.request(client, from ?? {})),
      onChange: (notices, session) => {
        release()
        const next: Shown[] = []
        for (const notice of notices) {
          const key = `${session}:${notice.id}`
          if (!claims.has(key)) {
            claims.set(key, owner)
            next.push({ key, notice })
          }
        }
        setShown(next)
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
      release()
      setShown([])
    }
  }, [client, capable])
  if (!client || !capable) {
    return null
  }
  return (
    <>
      {shown.map(({ key, notice }) => {
        const agent = generatedInputAgentName(notice.agent)
        const message =
          notice.certainty === 'unconfirmed'
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
        return (
          <HostRouteNoticeBanner
            key={key}
            message={message}
            tone="failure"
            action={{
              label: t('agentPrompt.copy', 'Copy prompt'),
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
      })}
    </>
  )
}
