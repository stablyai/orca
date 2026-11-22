// Settings › Tools: the bot's own tools, the ones it gets from its owner's agent, and Add a tool,
// like the desktop's BotToolsSection, with each tool on a page of its own.
import { useEffect, useState } from 'react'
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
import { getUiIntlLocale } from '../../i18n/ui-intl-locale'
import type { Translate } from '../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useBackClaim } from '../../navigation/use-back-claim'
import { SettingsNote, SettingsSection } from '../../settings/settings-screen-frame'
import { colors } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { botAgentLabel } from '../mobile-bot-sheet-copy'
import { MobileBotSettingsOffline } from '../MobileBotSettingsOffline'
import { MobileBotTextButton } from '../MobileBotTextButton'
import { botToolsListRead, type PhoneOwnTool } from './bot-tool-operations'
import {
  botToolAppName,
  botToolSignInActionLabel,
  botToolSignInLine,
  type ToolsBot
} from './bot-tool-words'
import { MobileBotAddToolPage } from './MobileBotAddToolPage'
import { MobileBotToolPage } from './MobileBotToolPage'
import { useBotToolsPage, type PhoneBotTools } from './use-bot-tools-page'

function toolsLine(tools: PhoneBotTools | null, agent: string, t: Translate): string | null {
  return botToolsLine(tools, {
    none: t('bots.tools.none', 'None'),
    from: (count) => t('bots.tools.from', '{{count}} from {{agent}}', { count, agent }),
    more: (count) => t('bots.tools.more', '{{count}} more from {{agent}}', { count, agent }),
    list: (names) =>
      new Intl.ListFormat(getUiIntlLocale(), { type: 'unit', style: 'short' }).format(names)
  })
}

/** Settings' Tools row, under Who can ask; the line under it reads the tools without checking them. */
export function MobileBotToolsRow(props: {
  client: RpcClient | null
  bot: ToolsBot
  online: boolean
  onOpen: () => void
}) {
  const t = useMobileTranslation()
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
          : (toolsLine(tools, botAgentLabel(props.bot.agent), t) ?? '')
      }
      detail
      disabled={!props.online}
      onPress={props.onOpen}
    />
  )
}

type Opened = { name: string; signIn: boolean }

export function MobileBotToolsPage(props: {
  client: RpcClient | null
  bot: ToolsBot
  hostName: string
  online: boolean
  onBack: () => void
  showToast: (message: string, durationMs?: number) => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
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
        showToast={props.showToast}
      />
    )
  }
  if (adding) {
    const inheritedNames = (page.tools?.inherited ?? [])
      .filter((entry) => !entry.plugin)
      .map((entry) => entry.name)
    return (
      <MobileBotAddToolPage
        client={props.client}
        bot={props.bot}
        taken={
          new Set([
            ...(page.tools?.own ?? []).map((entry) => entry.name),
            // The host refuses an owner's own server's name too; a plugin's doesn't clash.
            ...inheritedNames
          ])
        }
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
  return (
    <>
      <SheetHeader
        title={t('bots.tools.title', 'Tools')}
        onBack={{ label: t('bots.lookAround.back', 'Back to Settings'), onPress: props.onBack }}
      />
      {banner}
      <SettingsSection
        first
        separatorInset={LIST_LEADING_INSET}
        footer={page.error ? <SettingsNote error>{page.error}</SettingsNote> : undefined}
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
        <ListRow
          key="add"
          title={t('bots.tools.add', 'Add a tool')}
          leading={<Plus size={18} color={colors.textMuted} />}
          disabled={!props.online}
          onPress={() => setAdding(true)}
        />
      </SettingsSection>
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

function ToolRow(props: {
  tool: PhoneOwnTool
  problem: BotToolProblem | undefined
  hostName: string
  disabled: boolean
  onOpen: (signIn: boolean) => void
}) {
  const t = useMobileTranslation()
  const { tool, problem } = props
  const face = botToolSignInFace(tool, problem, false, undefined)
  const signInLine = face === 'signed-in' ? null : botToolSignInLine(face, t, props.hostName)
  const action = botToolSignInActionLabel(face, t)
  const trouble =
    problem?.kind === 'failed'
      ? t('bots.tools.wontStart', 'Won’t start')
      : problem?.kind === 'unconfirmed'
        ? t('bots.tools.unconfirmed', 'Not confirmed')
        : null
  const name = botToolAppName(tool.name)
  return (
    <ListRow
      title={name}
      subtitle={signInLine ?? trouble ?? botToolSubtitle(tool)}
      subtitleColor={signInLine ? colors.agentQuestion : trouble ? colors.statusAmber : undefined}
      subtitleLines={1}
      leading={<Wrench size={17} color={colors.textMuted} />}
      accessory={
        action ? (
          <MobileBotTextButton
            label={action}
            accessibilityLabel={`${action}, ${name}`}
            disabled={props.disabled}
            onPress={() => props.onOpen(true)}
          />
        ) : undefined
      }
      navigates={!action}
      onPress={() => props.onOpen(false)}
    />
  )
}
