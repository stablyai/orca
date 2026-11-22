// Settings' Soul, Memory, Tools and Skills: what Memory's row counts, Access's rows in the desktop's
// order (Tools, then Skills), and the open page.
import type { ReactNode } from 'react'
import { ListRow } from '../components/list/ListGroup'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { SheetBot } from './bot-sheet-operations'
import type { SettingsRootPage } from './MobileBotSettingsRoot'
import { MobileBotToolsPage, MobileBotToolsRow } from './tools/MobileBotToolsPage'
import { botSkillSourceCount, MobileBotSkillsPage, useBotSkillScan } from './skills/MobileBotSkills'
import { MobileBotMemoryPage, MobileBotSoulPage } from './soul-memory/MobileBotSoulAndMemory'
import { botMemoryTopicCount, useBotMemoryTopicNames } from './soul-memory/use-bot-home-files'

export function useBotSoulMemorySkills(
  settings: {
    client: RpcClient | null
    routeBot: { bot: SheetBot; reads: number }
    showToast: (message: string, durationMs?: number) => void
    online: boolean
    hostName: string
    onAskInChat?: ((draft: string) => void) | null
    onOpenFile?: (path: string) => void
  },
  banner: ReactNode,
  page: SettingsRootPage | null,
  setPage: (page: SettingsRootPage | null) => void,
  save: (updates: { skillProjects: string[] }) => Promise<boolean>
): {
  memoryTopics: number | null
  accessRows: ReactNode
  page: ReactNode
} {
  const t = useMobileTranslation()
  const { client, routeBot } = settings
  const { bot, reads } = routeBot
  const topicNames = useBotMemoryTopicNames(client, bot.folderWorkspaceId, reads)
  const scan = useBotSkillScan(client, bot, bot.skillProjects ?? [], reads)
  const shared = {
    client,
    bot,
    reads,
    showToast: settings.showToast,
    online: settings.online,
    hostName: settings.hostName,
    banner,
    onBack: () => setPage(null)
  }
  const skills = botSkillSourceCount(scan)
  return {
    memoryTopics: topicNames ? botMemoryTopicCount(topicNames) : null,
    // An array, not a fragment, so the group draws a line between the rows.
    accessRows: [
      <MobileBotToolsRow key="tools" {...settings} bot={bot} onOpen={() => setPage('tools')} />,
      <ListRow
        key="skills"
        title={t('bots.skills.title', 'Skills')}
        value={
          skills === null
            ? undefined
            : skills > 0
              ? String(skills)
              : t('bots.settings.none', 'None')
        }
        navigates
        onPress={() => setPage('skills')}
      />
    ],
    page:
      page === 'tools' ? (
        <MobileBotToolsPage {...settings} bot={bot} onBack={() => setPage(null)} />
      ) : page === 'soul' ? (
        <MobileBotSoulPage {...shared} onAskInChat={settings.onAskInChat ?? null} />
      ) : page === 'memory' ? (
        <MobileBotMemoryPage
          {...shared}
          topicNames={topicNames}
          onOpenFile={settings.onOpenFile ?? null}
        />
      ) : page === 'skills' ? (
        <MobileBotSkillsPage
          {...shared}
          scan={scan}
          save={(skillProjects) => save({ skillProjects })}
        />
      ) : null
  }
}
