import { useEffect, useState } from 'react'
import { z } from 'zod'
import { getAgentLabel } from '../../../src/shared/agent-detection'
import { isTuiAgent } from '../../../src/shared/tui-agent-config'
import { GENERATED_INPUT_RECOVERY_RUNTIME_CAPABILITY } from '../../../src/shared/terminal-runtime-capabilities'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import type { RpcClient } from '../transport/rpc-client'
import { useClipboardWriter } from '../platform/clipboard'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { HostRouteNoticeBanner } from './HostRouteNoticeBanner'

const noticeList = z.array(
  z.object({
    id: z.string(),
    agent: z.string(),
    text: z.string(),
    certainty: z.enum(['not-sent', 'unconfirmed'])
  })
)
const dismissNotice = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'terminal.dismiss-generated-input-notice',
    method: 'terminal.dismissGeneratedInputNotice',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('dismissed', z.object({ dismissed: z.literal(true) }))
  })
)

export function GeneratedInputNotices({
  client,
  capabilities
}: {
  client: RpcClient | null
  capabilities: readonly string[]
}) {
  const t = useMobileTranslation()
  const clipboard = useClipboardWriter()
  const [projection, setProjection] = useState<{
    client: RpcClient
    notices: z.infer<typeof noticeList>
  } | null>(null)
  const capable = capabilities.includes(GENERATED_INPUT_RECOVERY_RUNTIME_CAPABILITY)
  useEffect(() => {
    if (!client || !capable) {
      return
    }
    return client.subscribe('runtime.clientEvents.subscribe', null, (payload) => {
      if (!payload || typeof payload !== 'object' || !('type' in payload)) {
        return
      }
      let raw: unknown
      if (payload.type === 'generatedInputNoticesChanged' && 'notices' in payload) {
        raw = payload.notices
      } else if (
        payload.type === 'ready' &&
        'snapshot' in payload &&
        payload.snapshot &&
        typeof payload.snapshot === 'object' &&
        'generatedInputNotices' in payload.snapshot
      ) {
        raw = payload.snapshot.generatedInputNotices
      } else {
        return
      }
      const parsed = noticeList.safeParse(raw)
      if (parsed.success) {
        setProjection({ client, notices: parsed.data })
      }
    })
  }, [client, capable])
  if (!client || !capable || projection?.client !== client) {
    return null
  }
  return (
    <>
      {projection.notices.map((notice) => {
        const agent = isTuiAgent(notice.agent) ? getAgentLabel(notice.agent) : 'The agent'
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
            key={notice.id}
            message={message}
            tone="failure"
            action={{
              label: t('agentPrompt.copy', 'Copy prompt'),
              onPress: () => {
                void clipboard.writeText(notice.text).catch(() => {})
              }
            }}
            onDismiss={() => {
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
