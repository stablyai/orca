import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import { makeTestBot } from './bot.test-fixture'
import { agentSessionRecordFixture } from '../native-chat/testing/agent-session-record-test-fixture'
import { localBotHomeFilesystem } from './bot-home'
import { createBotMemoryRecord } from './bot-memory-record'
import { botStructuredSessionWiring } from './bot-structured-session-wiring'
import { writeBotToolServers } from './bot-tools-file'
import { useBotToolCredentialsRoot } from './bot-tool-credentials'
import type { BotChatRow } from '../../shared/bots/bot-chat-row'
import { NO_BOT_CHAT_JOURNAL } from './bot-turn-rows'

const dirs: string[] = []
beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'bot-tool-credentials-'))
  dirs.push(root)
  useBotToolCredentialsRoot(root)
})
afterEach(() => {
  useBotToolCredentialsRoot(null)
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("a bot chat's launch", () => {
  it("prepares every launch by moving the bot's saved values first", async () => {
    const folder = mkdtempSync(join(tmpdir(), 'bot-wiring-'))
    dirs.push(folder)
    const bot = makeTestBot({ id: 'scout', folderWorkspaceId: 'scout-home', agent: 'claude' })
    const scrubbed = Promise.withResolvers<void>()
    const scrubs: string[] = []
    const wiring = botStructuredSessionWiring({
      store: () => ({ getBots: () => [bot], getRepos: () => [] }),
      botsAtInstall: [bot],
      bots: {
        endFirstRun: async () => undefined,
        memory: createBotMemoryRecord(localBotHomeFilesystem)
      },
      chats: NO_BOT_CHAT_JOURNAL,
      work: { turnNote: async () => null, handedOver: () => undefined, turnEnded: () => undefined },
      lookAround: { botOfLook: () => null, botOfTidyUp: () => null, lookTurnIsQuiet: () => false },
      scrubToolSecrets: (entry) => {
        scrubs.push(entry.id)
        return scrubbed.promise
      }
    })
    let resolved = false
    const launch = wiring
      .prepareSessionLaunch(
        agentSessionRecordFixture({
          sessionId: 'chat-1',
          location: { workspaceId: folderWorkspaceKey('scout-home') }
        }),
        folder
      )
      .then(() => (resolved = true))
    // This launch's own cleanup and the startup sweep's; the launch is still waiting on its own.
    await vi.waitFor(() => expect(scrubs).toEqual(['scout', 'scout']))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(resolved).toBe(false)
    scrubbed.resolve()
    await launch
    expect(resolved).toBe(true)
  })
})

describe("a bot chat's tools", () => {
  it('reads as changed once the tools change after its launch, and never for a chat that launched none', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'bot-wiring-'))
    dirs.push(folder)
    const bot = makeTestBot({ id: 'scout', folderWorkspaceId: 'scout-home', agent: 'codex' })
    const wiring = botStructuredSessionWiring({
      store: () => ({ getBots: () => [bot], getRepos: () => [] }),
      bots: {
        endFirstRun: async () => undefined,
        memory: createBotMemoryRecord(localBotHomeFilesystem)
      },
      chats: NO_BOT_CHAT_JOURNAL,
      work: { turnNote: async () => null, handedOver: () => undefined, turnEnded: () => undefined },
      lookAround: { botOfLook: () => null, botOfTidyUp: () => null, lookTurnIsQuiet: () => false }
    })
    await wiring.resolveSessionToolServers(
      agentSessionRecordFixture({
        sessionId: 'chat-1',
        provider: 'codex',
        location: { workspaceId: folderWorkspaceKey('scout-home') }
      }),
      folder
    )
    expect(await wiring.launchTools.changed('chat-1')).toBe(false)
    expect(wiring.launchTools.outdated('chat-1')).toBe(false)

    await writeBotToolServers(folder, [{ name: 'vercel', url: 'https://mcp.vercel.com' }])

    expect(await wiring.launchTools.changed('chat-1')).toBe(true)
    expect(wiring.launchTools.outdated('chat-1')).toBe(true)
    expect(await wiring.launchTools.changed('look-around')).toBe(false)
    expect(wiring.launchTools.outdated('look-around')).toBe(false)
  })
})

describe('a picked chat in a message', () => {
  it("writes --chat only for the bot's own chat that takes mail, and never falls back to Home", async () => {
    const bot = makeTestBot({ id: 'perf', name: 'Perf bot', folderWorkspaceId: 'perf-home' })
    const row = (id: string, extra: Partial<BotChatRow> = {}): BotChatRow => ({
      id,
      title: `Chat ${id}`,
      lastActivityAt: 0,
      lastAsked: null,
      lastSaid: null,
      home: false,
      self: false,
      closed: false,
      ...extra
    })
    const asked: string[] = []
    const wiring = botStructuredSessionWiring({
      store: () => ({ getBots: () => [bot], getRepos: () => [] }),
      bots: {
        endFirstRun: async () => undefined,
        memory: createBotMemoryRecord(localBotHomeFilesystem)
      },
      chats: NO_BOT_CHAT_JOURNAL,
      work: { turnNote: async () => null, handedOver: () => undefined, turnEnded: () => undefined },
      lookAround: { botOfLook: () => null, botOfTidyUp: () => null, lookTurnIsQuiet: () => false },
      botChats: async (_bot, sessionId) => {
        asked.push(sessionId)
        return [
          row('open'),
          row('ended', { closed: true, reason: 'ended' }),
          row('elsewhere', { closed: true, reason: 'other-host' }),
          row('mine', { self: true })
        ]
      }
    })
    const token = (chat: string) => `[Bot: Perf bot](bot-chat:perf/${chat})`
    const message = {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [
        {
          type: 'text' as const,
          text: ['open', 'ended', 'elsewhere', 'mine', 'stranger'].map(token).join(' ')
        }
      ]
    }
    const context = await wiring.turnContext.mentions!('asking-chat', message)
    // One read of the bot's chats, as the asking chat sees them.
    expect(asked).toEqual(['asking-chat'])
    const lines = context!.replace(/<\/?orca_context>/g, '').split('\n')
    expect(lines).toHaveLength(5)
    expect(lines[0]).toContain('titled "Chat open"')
    expect(lines[0]).toContain('--to "bot:Perf bot" --chat open --type')
    for (const [line, why] of [
      [lines[1], 'it was closed'],
      [lines[2], 'it runs on another computer'],
      [lines[3], 'it is this chat'],
      [lines[4], "it isn't one of this bot's chats"]
    ]) {
      expect(line).toContain(`can't take messages now (${why}). Don't send this to any other chat`)
      expect(line).not.toContain('orca orchestration send')
    }
  })

  it("tells the agent how to reach a paired server's bot it names, read from that server", async () => {
    const asked: string[][] = []
    const server = { name: 'm4 air', on: 'm4 air' }
    const wiring = botStructuredSessionWiring({
      store: () => ({ getBots: () => [], getRepos: () => [] }),
      bots: {
        endFirstRun: async () => undefined,
        memory: createBotMemoryRecord(localBotHomeFilesystem)
      },
      chats: NO_BOT_CHAT_JOURNAL,
      work: { turnNote: async () => null, handedOver: () => undefined, turnEnded: () => undefined },
      lookAround: { botOfLook: () => null, botOfTidyUp: () => null, lookTurnIsQuiet: () => false },
      pairedBotRosters: async (servers) => {
        asked.push([...servers])
        return [
          // Not read yet: named as picked, with no purpose.
          { environmentId: 'env-box', server: { name: 'Build Box', on: 'Build Box' }, bots: null },
          {
            environmentId: 'env-air',
            server,
            bots: [
              {
                id: 'rel',
                name: 'Releases',
                agent: 'codex',
                paused: false,
                specialty: 'Cuts releases',
                linked: [],
                server
              }
            ]
          }
        ]
      }
    })
    const message = {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [
        {
          type: 'text' as const,
          // The second is gone from its server, the third on a server this host isn't paired to.
          text: '[Bot: Releases](bot:rel@env-air) [Bot: Old](bot:old@env-air) [Bot: X](bot:x@env-far) [Bot: QA](bot:qa@env-box)'
        }
      ]
    }
    const context = await wiring.turnContext.mentions!('asking-chat', message)
    expect(asked).toEqual([['env-air', 'env-far', 'env-box']])
    expect(context).toBe(
      `<orca_context>Releases is the user's Orca bot on their computer "m4 air" ("Cuts releases"). To ask it, run \`orca orchestration send --on 'm4 air' --to bot:Releases --type question|handoff --subject … --body …\`; don't message it unless asked.\nQA is the user's Orca bot on their computer "Build Box". To ask it, run \`orca orchestration send --on 'Build Box' --to bot:QA --type question|handoff --subject … --body …\`; don't message it unless asked.</orca_context>`
    )
  })
})
