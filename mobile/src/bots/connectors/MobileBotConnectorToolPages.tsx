// Connectors' tool-app pages: an app's own page (Settings › Tools' tool page), and Add by URL, which
// opens the new app's page once added, on its sign-in when it has one.
import { useEffect, type ReactNode } from 'react'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { PhoneBot } from '../host-bots-operations'
import { MobileBotAddToolPage } from '../tools/MobileBotAddToolPage'
import { MobileBotToolPage } from '../tools/MobileBotToolPage'
import type { useBotToolsPage } from '../tools/use-bot-tools-page'
import type { ConnectorPage } from './connector-pages'

export function MobileBotConnectorToolPages(props: {
  page: Extract<ConnectorPage, { kind: 'tool' | 'add-tool' }>
  setPage: (page: ConnectorPage) => void
  client: RpcClient | null
  bot: PhoneBot
  tools: ReturnType<typeof useBotToolsPage>
  hostName: string
  online: boolean
  banner: ReactNode
  showToast: (message: string, durationMs?: number) => void
}) {
  const { page, setPage, tools } = props
  const tool =
    page.kind === 'tool' ? tools.tools?.own.find((entry) => entry.name === page.name) : undefined
  // An app removed (here or elsewhere) goes back to the list.
  const gone = page.kind === 'tool' && tools.tools !== null && !tool
  useEffect(() => {
    if (gone) {
      setPage({ kind: 'list' })
    }
  }, [gone, setPage])
  if (page.kind === 'add-tool') {
    return (
      <MobileBotAddToolPage
        client={props.client}
        bot={props.bot}
        taken={
          new Set([
            ...(tools.tools?.own ?? []).map((entry) => entry.name),
            // The host refuses an owner's own server's name too; a plugin's doesn't clash.
            ...(tools.tools?.inherited ?? [])
              .filter((entry) => !entry.plugin)
              .map((entry) => entry.name)
          ])
        }
        preset={page.preset}
        hostName={props.hostName}
        online={props.online}
        banner={props.banner}
        onCancel={() => setPage(page.from)}
        onAdded={async (added) => {
          // Read first, so the new app's page opens straight from Add.
          await tools.reread(true)
          setPage({ kind: 'tool', name: added.name, signIn: added.signIn !== undefined })
        }}
      />
    )
  }
  if (!tool) {
    return null
  }
  return (
    <MobileBotToolPage
      client={props.client}
      bot={props.bot}
      tool={tool}
      problem={tools.problems?.[tool.name]}
      checking={tools.problems === null}
      signInFirst={page.signIn}
      hostName={props.hostName}
      online={props.online}
      banner={props.banner}
      onBack={() => setPage({ kind: 'list' })}
      onChanged={(recheck) => void tools.reread(recheck)}
      onCheckAgain={tools.checkAgain}
      showToast={props.showToast}
    />
  )
}
