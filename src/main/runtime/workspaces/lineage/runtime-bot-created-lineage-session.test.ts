import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTestBot } from '../../../bots/bot.test-fixture'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { readActingSessionRecord } from '../../rpc/orchestration/callers/orchestration-session-caller'
import {
  createSessionCallerHarness,
  SESSION_X,
  sessionRecord,
  type SessionCallerHarness
} from '../../rpc/orchestration/callers/session.test-fixture'
import {
  partialRuntimeStore,
  storeFolderWorkspace
} from '../../construction/test-context/runtime-store-partial-fixture'
import { BotWorktreeLineageController } from './runtime-bot-worktree-lineage-controller'
import { folderSelectorResolver } from './runtime-bot-lineage.test-fixture'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../../../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

const BOT_HOME = storeFolderWorkspace({ id: 'scout-home', projectGroupId: 'g', folderPath: '/s' })

describe('bot-created worktree lineage from a real session record', () => {
  let harness: SessionCallerHarness
  let controller: BotWorktreeLineageController

  beforeEach(() => {
    harness = createSessionCallerHarness(hostRef)
    // A bot home chat's record names its folder the way the session host writes it.
    harness.records.set(
      SESSION_X,
      sessionRecord(SESSION_X, {
        location: { workspaceId: folderWorkspaceKey(BOT_HOME.id), workspaceKind: 'folder' }
      })
    )
    controller = new BotWorktreeLineageController({
      getStore: () =>
        partialRuntimeStore({
          getBots: () => [makeTestBot({ folderWorkspaceId: BOT_HOME.id })],
          getFolderWorkspaces: () => [BOT_HOME]
        }),
      getDb: () => null,
      resolveWorkspace: folderSelectorResolver([BOT_HOME]),
      showTerminal: async () => {
        throw new Error('terminal_handle_stale')
      },
      getSessionWorkspaceKey: async (sessionId) =>
        (await readActingSessionRecord(harness.runtime, sessionId, 'worktree.create')).record
          .location.workspaceId
    })
  })

  afterEach(() => harness.close())

  it("files the bot home chat's --no-parent create under the bot", async () => {
    await expect(
      controller.resolveCreate({ noParent: true, callerAgentSessionId: SESSION_X })
    ).resolves.toMatchObject({
      kind: 'lineage',
      parent: { workspaceKey: folderWorkspaceKey(BOT_HOME.id) },
      origin: 'orchestration'
    })
  })

  it('ignores an id that names no session on this host', async () => {
    await expect(
      controller.resolveCreate({ noParent: true, callerAgentSessionId: 'not-a-session' })
    ).resolves.toEqual({ kind: 'none', warnings: [] })
  })
})
