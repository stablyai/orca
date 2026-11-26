// Who can ask's paired servers, as the desktop's BotPairedServersWhoCanAsk: the servers always allowed
// to ask the bot without a card, each removable. Adding one without a card stays on the desktop.
import { useEffect, useRef, useState } from 'react'
import * as z from 'zod'
import { ORCHESTRATION_CLIENT_AGENT_ASKS_RUNTIME_CAPABILITY } from '../../../src/shared/orchestration/orchestration-runtime-capabilities'
import { botChangeConcerns, readBotChangeScope } from '../../../src/shared/bots/bot-change-scope'
import { useOptionalHostProtocolGates } from '../components/host-connection/host-protocol-gates-context'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { SettingsSection } from '../settings/settings-screen-frame'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../transport/rpc/rpc-operation-result-reader'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { subscribeSharedClientEvents } from '../transport/connection/shared-client-events'
import { MobileWhoCanAskServerRow, WHO_FACE_INSET } from './MobileWhoCanAskRows'

const Allowance = z.object({
  serverKey: z.string(),
  environmentId: z.string(),
  serverName: z.string().nullish()
})
type Allowance = z.infer<typeof Allowance>

const allowancesRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'paired-server-asks.allowances',
    method: 'pairedServerAsks.allowances',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'paired-server-allowances',
      z.looseObject({ servers: z.array(Allowance) })
    )
  })
)

const disallowServer = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'paired-server-asks.disallow',
    method: 'pairedServerAsks.disallow',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('paired-server-disallowed', z.looseObject({ removed: z.boolean() }))
  })
)

const NONE: readonly Allowance[] = []

/** The servers always allowed to ask `botId`, from its host, reread with each of its chats notices
 *  (an Always allow on a card lands as one) and by `reread`; only the newest read lands. None on a
 *  host that won't tell the phone. */
function useAllowances(
  client: RpcClient | null,
  botId: string
): { servers: readonly Allowance[]; reread: () => void } {
  const supported =
    useOptionalHostProtocolGates()?.hostCapabilities.includes(
      ORCHESTRATION_CLIENT_AGENT_ASKS_RUNTIME_CAPABILITY
    ) === true
  const [servers, setServers] = useState(NONE)
  const reads = useRef({ latest: 0, read: () => {} })
  useEffect(() => {
    setServers(NONE)
    if (!supported || !client) {
      return
    }
    let live = true
    const read = (): void => {
      const mine = ++reads.current.latest
      void allowancesRead
        .request(client, { botId })
        .then((reply) => {
          const found = allowancesRead.interpret(reply).servers
          if (live && mine === reads.current.latest) {
            setServers(found.length > 0 ? found : NONE)
          }
        })
        // A host from before the phone could read them has none to show.
        .catch(() => {})
    }
    const stop = subscribeSharedClientEvents(client, (event) => {
      if (
        event.type === 'ready' ||
        (event.type === 'botsChanged' &&
          botChangeConcerns(readBotChangeScope(event), { botId, kinds: ['chats'] }))
      ) {
        read()
      }
    })
    reads.current.read = read
    return () => {
      live = false
      reads.current.read = () => {}
      stop()
    }
  }, [client, botId, supported])
  return { servers, reread: () => reads.current.read() }
}

export function MobileBotPairedServers(props: {
  client: RpcClient | null
  bot: { id: string; name: string }
  locked: boolean
  showToast: (message: string, durationMs?: number) => void
}) {
  const t = useMobileTranslation()
  const { client, bot } = props
  const { servers, reread } = useAllowances(client, bot.id)
  if (servers.length === 0) {
    return null
  }
  const remove = (server: Allowance) => {
    if (!client) {
      return
    }
    void disallowServer
      .request(
        client,
        { botId: bot.id, serverKey: server.serverKey },
        { failWhenDisconnected: true }
      )
      .then((reply) => disallowServer.interpret(reply))
      .catch((error: unknown) =>
        props.showToast(error instanceof Error ? error.message : String(error), 2400)
      )
      // The host sends no notice for it; a read started earlier must not land over it.
      .finally(reread)
  }
  return (
    <SettingsSection
      title={t('bots.pairedServers.heading', 'Paired servers')}
      separatorInset={WHO_FACE_INSET}
      footer={t('bots.pairedServers.footer', 'Their agents can ask without your approval.')}
    >
      {servers.map((server) => (
        <MobileWhoCanAskServerRow
          key={server.serverKey}
          // An older host names none.
          name={server.serverName || t('bots.pairedServers.unnamed', 'Paired server')}
          busy={props.locked}
          onRemove={() => remove(server)}
        />
      ))}
    </SettingsSection>
  )
}
