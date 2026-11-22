// Guards #45466 (STA-16840): newer-agent bot order reconstruction and chat/notification bot lookups.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../../../shared/orca-profiles/constants'
import { splitBotsByOlderBuildSupport } from '../../../../shared/bot-types'
import {
  folderWorkspaceKey,
  worktreeWorkspaceKey
} from '../../../../shared/workspace/identity/workspace-scope'
import { makeTestBot } from '../../../bots/bot.test-fixture'
import { createBotMemoryRecord } from '../../../bots/bot-memory-record'
import { localBotHomeFilesystem } from '../../../bots/bot-home'
import { botStructuredSessionWiring } from '../../../bots/bot-structured-session-wiring'
import { NO_BOT_CHAT_JOURNAL } from '../../../bots/bot-turn-rows'
import {
  closeTestStores,
  createStore,
  testState,
  writeDataFile
} from '../../persistence-test-harness'

vi.mock('electron', () => ({ app: { getPath: () => testState.dir } }))
vi.mock('../../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(() => []),
  sshConfigHostsToTargets: vi.fn(() => [])
}))
vi.mock('../../../telemetry/client', () => ({ track: vi.fn() }))

describe('BotPersistence and structured chat bot lookup contract (#45466)', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'bot-order-perf-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it.each([100, 1000])(
    'skips bot-store reads for %i worktree chat reads and reuses one ordered bot list across bot homes',
    async (count) => {
      const seeded = Array.from({ length: count }, (_, index) =>
        makeTestBot({
          id: `bot-${index}`,
          name: `Bot ${index}`,
          folder: `bot-${index}`,
          folderWorkspaceId: `home-${index}`,
          agent: index % 2 === 0 ? 'claude' : 'cursor'
        })
      )
      const { readable, newer } = splitBotsByOlderBuildSupport(seeded)
      writeDataFile({
        ...getDefaultPersistedState(testState.dir),
        bots: readable,
        botsNewerAgents: newer,
        botOrder: seeded.map((bot) => bot.id),
        botsPermissionDefaultMigrated: true
      })

      const reloaded = createStore()
      const getBots = vi.fn(() => reloaded.getBots())
      const wiring = botStructuredSessionWiring({
        store: () => ({ getBots, getRepos: () => [] }),
        bots: {
          endFirstRun: async () => undefined,
          memory: createBotMemoryRecord(localBotHomeFilesystem)
        },
        chats: NO_BOT_CHAT_JOURNAL,
        work: {
          turnNote: async () => null,
          handedOver: () => undefined,
          turnEnded: () => undefined
        },
        lookAround: {
          botOfLook: () => null,
          botOfTidyUp: () => null,
          lookTurnIsQuiet: () => false
        }
      })

      for (let index = 0; index < count; index += 1) {
        expect(wiring.isBotHome(worktreeWorkspaceKey(`repo::wt-${index}`))).toBe(false)
        expect(
          await wiring.turnContext.mentions!(`session-${index}`, {
            kind: 'message',
            role: 'user',
            blocks: [{ type: 'text', text: 'plain worktree message without bot mentions' }]
          })
        ).toBeNull()
      }
      expect(getBots).toHaveBeenCalledTimes(0)

      const firstOrdered = reloaded.getBots()
      expect(firstOrdered).toHaveLength(count)
      expect(firstOrdered[0]?.id).toBe('bot-0')
      expect(firstOrdered[1]?.id).toBe('bot-1')
      expect(firstOrdered[count - 1]?.id).toBe(`bot-${count - 1}`)

      for (let index = 0; index < count; index += 1) {
        expect(wiring.isBotHome(folderWorkspaceKey(`home-${index}`))).toBe(true)
        expect(reloaded.getBots()).toBe(firstOrdered)
      }
      expect(getBots).toHaveBeenCalledTimes(count)
    }
  )
})
