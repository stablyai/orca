// Settings' Soul, Memory, Tools and Skills: the Soul and memory rows, Access's rows in the desktop's
// order (Tools, then Skills), and the open page.
import type { ReactNode } from 'react'
import { ListRow } from '../components/list/ListGroup'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { SheetBot } from './bot-sheet-operations'
import type { SettingsFeature, SettingsRootPage } from './MobileBotSettingsRoot'
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
): SettingsFeature {
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
  const memoryTopics = topicNames ? botMemoryTopicCount(topicNames) : null
  return {
    rows: [
      {
        key: 'soul',
        group: 'soul-and-memory',
        node: (
          <ListRow title={t('bots.soul.title', 'Soul')} navigates onPress={() => setPage('soul')} />
        )
      },
      {
        key: 'memory',
        group: 'soul-and-memory',
        node: (
          <ListRow
            title={t('bots.memory.title', 'Memory')}
            value={
              memoryTopics === null
                ? undefined
                : t('bots.settings.memoryFiles', '{{count}} files', {
                    count: memoryTopics + 1,
                    defaultValue_one: '{{count}} file'
                  })
            }
            navigates
            onPress={() => setPage('memory')}
          />
        )
      },
      {
        key: 'tools',
        group: 'access',
        node: <MobileBotToolsRow {...settings} bot={bot} onOpen={() => setPage('tools')} />
      },
      {
        key: 'skills',
        group: 'access',
        node: (
          <ListRow
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
        )
      }
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
