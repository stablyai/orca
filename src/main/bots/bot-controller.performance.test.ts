import { describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../shared/bot-types'
import type { RuntimeStore } from '../runtime/construction/runtime-store-contract'
import { BotController } from './bot-controller'
import type { BotHomeFilesystem } from './bot-home'

describe('unchanged bot edits', () => {
  it.each([100, 1000])(
    'does no home IO or catalog publication with %i saved bots',
    async (count) => {
      const records: Bot[] = Array.from({ length: count }, (_, index) => ({
        id: `bot-${index}`,
        name: `Bot ${index}`,
        hostId: 'local',
        folder: `bot-${index}`,
        folderWorkspaceId: `fw-${index}`,
        agent: 'codex',
        avatar: null,
        paused: false,
        notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
        members: [],
        slack: null,
        slackApps: [],
        linear: null,
        github: null,
        chatSessionId: null,
        createdAt: 1,
        updatedAt: 1
      }))
      const saveBot = vi.fn()
      const notify = vi.fn()
      const store = {
        getBots: () => records,
        saveBot,
        removeBot: vi.fn(),
        getProjectGroups: () => [],
        createProjectGroup: vi.fn(),
        getFolderWorkspaces: () => [],
        updateFolderWorkspace: vi.fn()
      }
      const io = vi.fn()
      const filesystem: BotHomeFilesystem = {
        readText: io,
        readBytes: io,
        listNames: io,
        statFile: io,
        writeBytes: io,
        writeText: io,
        replaceText: io,
        reserveDirectory: io,
        makeDirectory: io,
        removeTree: io
      }
      const bots = new BotController({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: update reads only the bot-store methods above.
        getStore: () => store as RuntimeStore,
        filesystem,
        botsRoot: () => 'bots',
        notifyBotsWritten: notify,
        createFolderWorkspace: vi.fn(),
        deleteFolderWorkspace: vi.fn(),
        deleteBotAutomations: vi.fn()
      })
      const saved = records[count - 1]
      expect(await bots.update(`bot-${count - 1}`, () => null)).toBe(saved)
      expect(io).not.toHaveBeenCalled()
      expect(saveBot).not.toHaveBeenCalled()
      expect(notify).not.toHaveBeenCalled()
    }
  )
})
