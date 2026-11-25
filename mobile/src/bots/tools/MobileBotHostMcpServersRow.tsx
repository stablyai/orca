// Settings › Tools' first row: whether the bot's sessions also take its host's MCP servers, named
// under it. Shown only while the host's MCP servers switch is on (its tools read says so).
import { useEffect, useState } from 'react'
import { Server } from 'lucide-react-native'
import { MobileSwitch } from '../../components/controls/MobileSwitch'
import { ListRow } from '../../components/list/ListGroup'
import { getUiIntlLocale } from '../../i18n/ui-intl-locale'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { mcpServersListRead } from '../../mcp-servers/mcp-server-operations'
import { mcpServerTitle } from '../../mcp-servers/mcp-server-words'
import { colors } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { botToolSetHostMcpServers } from './bot-tool-operations'

export function MobileBotHostMcpServersRow(props: {
  client: RpcClient | null
  botId: string
  enabled: boolean
  online: boolean
  onChanged: () => void
  showToast: (message: string) => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const { client } = props
  const [names, setNames] = useState<string[] | null>(null)
  // The flip shows at once; the tools read after it confirms or puts it back.
  const [pending, setPending] = useState<boolean | null>(null)
  useEffect(() => {
    if (!client) {
      return undefined
    }
    let live = true
    void mcpServersListRead
      .request(client, {})
      .then((reply) => mcpServersListRead.interpret(reply).servers.map(mcpServerTitle))
      .then((read) => live && setNames(read))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [client])
  const label = t('bots.tools.hostMcpServers', 'Your MCP servers')
  const set = (enabled: boolean) => {
    if (!client) {
      return
    }
    setPending(enabled)
    void botToolSetHostMcpServers
      .request(client, { botId: props.botId, enabled }, { failWhenDisconnected: true })
      .then((reply) => botToolSetHostMcpServers.interpret(reply))
      .then(props.onChanged)
      .catch((caught: unknown) =>
        props.showToast(caught instanceof Error ? caught.message : String(caught))
      )
      .finally(() => setPending(null))
  }
  return (
    <ListRow
      title={label}
      subtitle={
        names === null
          ? undefined
          : names.length === 0
            ? t('bots.tools.none', 'None')
            : new Intl.ListFormat(getUiIntlLocale(), { type: 'unit', style: 'short' }).format(names)
      }
      subtitleLines={1}
      leading={<Server size={17} color={colors.textMuted} />}
      accessory={
        <MobileSwitch
          value={pending ?? props.enabled}
          disabled={!props.online || pending !== null}
          accessibilityLabel={label}
          onValueChange={set}
        />
      }
    />
  )
}
