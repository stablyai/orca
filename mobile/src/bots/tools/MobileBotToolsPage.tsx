// Settings › Tools: the bot's own tools, the ones it gets from its owner's agent, and Add a tool,
// like the desktop's BotToolsSection, with each tool on a page of its own.
import { useEffect, useState, type ReactNode } from 'react'
import { Plus, Wrench } from 'lucide-react-native'
import {
  botToolsLine,
  botToolSubtitle,
  botToolTitle
} from '../../../../src/shared/bots/bot-tool-labels'
import { botToolSignInFace } from '../../../../src/shared/bots/bot-tool-sign-in-face'
import { COMPOSIO_SESSION_MCP_URL } from '../../../../src/shared/composio/composio-apps'
import type { BotToolProblem } from '../../../../src/shared/bot-tools'
import { LIST_LEADING_INSET, ListRow } from '../../components/list/ListGroup'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { DrillRow } from '../../host-screen/workspace-options/workspace-option-rows'
import { intlLocaleFor } from '../../i18n/ui-intl-locale'
import type { Translate } from '../../i18n/mobile-i18n'
import { useMobileTranslation, useMobileUiLocale } from '../../i18n/use-mobile-translation'
import { useBackClaim } from '../../navigation/use-back-claim'
import { SettingsNote, SettingsSection } from '../../settings/settings-screen-frame'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { botAgentLabel } from '../mobile-bot-sheet-copy'
import { MobileBotSettingsOffline } from '../MobileBotSettingsOffline'
import { botToolsListRead, type PhoneOwnTool } from './bot-tool-operations'
import {
  botToolAppName,
  botToolSignInActionLabel,
  botToolSignInLine,
  type ToolsBot
} from './bot-tool-words'
import { MobileBotAddToolPage } from './MobileBotAddToolPage'
import { MobileBotEditToolPage } from './MobileBotEditToolPage'
import { MobileBotHostMcpServersRow } from './MobileBotHostMcpServersRow'
import { MobileBotToolPage } from './MobileBotToolPage'
import { useBotToolsPage, type PhoneBotTools } from './use-bot-tools-page'

function toolsLine(
  tools: PhoneBotTools | null,
  agent: string,
  t: Translate,
  intlLocale: string
): string | null {
  return botToolsLine(tools, {
    none: t('bots.tools.none', 'None'),
    from: (count) => t('bots.tools.from', '{{count}} from {{agent}}', { count, agent }),
    more: (count) => t('bots.tools.more', '{{count}} more from {{agent}}', { count, agent }),
    list: (names) => new Intl.ListFormat(intlLocale, { type: 'unit', style: 'short' }).format(names)
  })
}

/** Settings' Tools row, under Who can ask; the line under it reads the tools without checking them. */
export function MobileBotToolsRow(props: {
  client: RpcClient | null
  bot: ToolsBot
  onOpen: () => void
}) {
  const t = useMobileTranslation()
  const intlLocale = intlLocaleFor(useMobileUiLocale())
  const { client } = props
  const botId = props.bot.id
  const [tools, setTools] = useState<PhoneBotTools | 'failed' | null>(null)
  useEffect(() => {
    if (!client) {
      return
    }
    let live = true
    void botToolsListRead
      .request(client, { botId })
      .then((response) => {
        const read = botToolsListRead.interpret(response)
        if (live) {
          setTools({ own: read.own ?? [], inherited: read.inherited ?? [] })
        }
      })
      .catch(() => {
        if (live) {
          setTools('failed')
        }
      })
    return () => {
      live = false
    }
  }, [client, botId])
  return (
    <DrillRow
      label={t('bots.tools.title', 'Tools')}
      value={
        tools === 'failed'
          ? t('bots.settings.readFailed', 'Couldn’t load')
          : (toolsLine(tools, botAgentLabel(props.bot.agent), t, intlLocale) ?? '')
      }
      detail={tools !== 'failed'}
      onPress={props.onOpen}
    />
  )
}

type Opened = { name: string; signIn: boolean; editing?: boolean }

export function MobileBotToolsPage(props: {
  client: RpcClient | null
  bot: ToolsBot
  hostName: string
  online: boolean
  onBack: () => void
  showToast: (message: string, durationMs?: number) => void
}) {
  const t = useMobileTranslation()
  const colors = useMobileColors()
  const banner = <MobileBotSettingsOffline hostName={props.hostName} client={props.client} />
  const page = useBotToolsPage(props.client, props.bot.id)
  const [opened, setOpened] = useState<Opened | null>(null)
  const [adding, setAdding] = useState(false)
  useBackClaim(() => {
    props.onBack()
    return true
  })
  const agent = botAgentLabel(props.bot.agent)
  const own = (page.tools?.own ?? []).filter(
    // Composio's own server is drawn as its apps, under Connectors.
    (tool) => !COMPOSIO_SESSION_MCP_URL.test(tool.detail)
  )
  const tool = opened ? own.find((entry) => entry.name === opened.name) : undefined
  // The host refuses an owner's own server's name too; a plugin's doesn't clash.
  const inheritedNames = (page.tools?.inherited ?? [])
    .filter((entry) => !entry.plugin)
    .map((entry) => entry.name)
  const takenBesides = (name?: string) =>
    new Set([
      ...(page.tools?.own ?? []).map((entry) => entry.name).filter((entry) => entry !== name),
      ...inheritedNames
    ])
  if (opened?.editing && tool) {
    return (
      <MobileBotEditToolPage
        client={props.client}
        bot={props.bot}
        name={tool.name}
        taken={takenBesides(tool.name)}
        hostName={props.hostName}
        online={props.online}
        banner={banner}
        onCancel={() => setOpened({ name: tool.name, signIn: false })}
        onSaved={async (saved) => {
          await page.reread(true)
          setOpened({ name: saved.name, signIn: false })
        }}
      />
    )
  }
  if (opened && tool) {
    return (
      <MobileBotToolPage
        client={props.client}
        bot={props.bot}
        tool={tool}
        problem={page.problems?.[tool.name]}
        checking={page.problems === null}
        signInFirst={opened.signIn}
        hostName={props.hostName}
        online={props.online}
        banner={banner}
        onBack={() => setOpened(null)}
        onChanged={(recheck) => void page.reread(recheck)}
        onCheckAgain={page.checkAgain}
        onEdit={() => setOpened({ name: tool.name, signIn: false, editing: true })}
        showToast={props.showToast}
      />
    )
  }
  if (adding) {
    return (
      <MobileBotAddToolPage
        client={props.client}
        bot={props.bot}
        taken={takenBesides()}
        hostName={props.hostName}
        online={props.online}
        banner={banner}
        onCancel={() => setAdding(false)}
        onAdded={async (added) => {
          // Read first, so the new tool's page opens straight from Add.
          await page.reread(true)
          setAdding(false)
          setOpened({ name: added.name, signIn: false })
        }}
      />
    )
  }
  const inherited = page.tools?.inherited ?? []
  const hostMcp = page.tools?.hostMcpServers
  return (
    <>
      <SheetHeader
        title={t('bots.tools.title', 'Tools')}
        onBack={{ label: t('bots.lookAround.back', 'Back to Settings'), onPress: props.onBack }}
      />
      {banner}
      {hostMcp !== undefined ? (
        <SettingsSection first separatorInset={LIST_LEADING_INSET}>
          <MobileBotHostMcpServersRow
            client={props.client}
            botId={props.bot.id}
            enabled={hostMcp}
            online={props.online}
            onChanged={() => void page.reread()}
            showToast={props.showToast}
          />
        </SettingsSection>
      ) : null}
      {/* Offline, Add and the failed read only repeat what the banner says. */}
      {own.length > 0 || props.online ? (
        <SettingsSection
          first={hostMcp === undefined}
          separatorInset={LIST_LEADING_INSET}
          footer={
            page.error && props.online ? <SettingsNote error>{page.error}</SettingsNote> : undefined
          }
        >
          {own.map((entry) => (
            <ToolRow
              key={entry.name}
              tool={entry}
              problem={page.problems?.[entry.name]}
              hostName={props.hostName}
              disabled={!props.online}
              onOpen={(signIn) => setOpened({ name: entry.name, signIn })}
            />
          ))}
          {props.online ? (
            <ListRow
              key="add"
              title={t('bots.tools.add', 'Add a tool')}
              leading={<Plus size={18} color={colors.textMuted} />}
              onPress={() => setAdding(true)}
            />
          ) : null}
        </SettingsSection>
      ) : null}
      {inherited.length > 0 ? (
        <SettingsSection
          footer={t('bots.tools.readOnly', 'Read-only here. Change them in {{agent}}.', { agent })}
        >
          <ListRow
            title={t('bots.tools.fromYours', '{{count}} from your {{agent}}', {
              count: inherited.length,
              agent
            })}
            subtitle={inherited.map((entry) => botToolTitle(entry.name)).join(', ')}
            subtitleLines={3}
            leading={<Wrench size={17} color={colors.textMuted} />}
          />
        </SettingsSection>
      ) : null}
    </>
  )
}

/** One tool as a row; Connectors draws an app with its connector title and, for a listed app, its line. */
export function ToolRow(props: {
  title?: string
  line?: string
  /** The app's own logo, for a listed app. */
  leading?: ReactNode
  tool: PhoneOwnTool
  problem: BotToolProblem | undefined
  hostName: string
  disabled: boolean
  onOpen: (signIn: boolean) => void
}) {
  const colors = useMobileColors()
  const t = useMobileTranslation()
  const { tool, problem } = props
  const face = botToolSignInFace(tool, problem, false, undefined)
  const signInLine = face === 'signed-in' ? null : botToolSignInLine(face, t, props.hostName)
  const signIn = botToolSignInActionLabel(face, t) !== null
  const trouble =
    problem?.kind === 'failed'
      ? t('bots.tools.wontStart', 'Won’t start')
      : problem?.kind === 'unconfirmed'
        ? t('bots.tools.unconfirmed', 'Not confirmed')
        : null
  const name = props.title ?? botToolAppName(tool.name)
  return (
    <ListRow
      title={name}
      subtitle={signInLine ?? trouble ?? props.line ?? botToolSubtitle(tool)}
      subtitleColor={
        signInLine
          ? colors.agentQuestion
          : problem?.kind === 'failed'
            ? colors.statusRed
            : undefined
      }
      subtitleLines={1}
      leading={props.leading ?? <Wrench size={17} color={colors.textMuted} />}
      navigates
      // A tool that needs a sign-in opens on it; Back from there is the tool's page.
      onPress={() => props.onOpen(signIn && !props.disabled)}
    />
  )
}
