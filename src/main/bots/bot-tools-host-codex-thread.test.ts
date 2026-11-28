import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BotToolServer } from '../../shared/bot-tools'
import { isPlainObject } from '../agent-hooks/installation/configuration/hooks-json-read'
import { SessionMcpTools } from '../mcp-servers/session-mcp-tools'
import { codexThread } from './bot-tools-codex'
import { codexStdioToolNames, type BotToolsCli } from './bot-tools-host'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** A bot on an account whose config.toml holds `accountConfig` (none when absent). */
function botCli(accountConfig?: string): BotToolsCli {
  const accountHome = mkdtempSync(join(tmpdir(), 'codex-home-'))
  dirs.push(accountHome)
  if (accountConfig !== undefined) {
    writeFileSync(join(accountHome, 'config.toml'), accountConfig)
  }
  return {
    botId: 'bot-1',
    folder: '/bots/one',
    signInFolder: '/bots/one-sign-in',
    otherBotFolders: [],
    agent: 'codex',
    command: 'codex',
    prefixArgs: [],
    env: {},
    accountHome
  }
}

const relay = { grant: async () => ({ origin: 'http://127.0.0.1:1', token: 'token' }) }

/** An app-server whose loaded config (`config/read`, every layer) has `loaded`, recording the thread it starts. */
function appServer(loaded: Record<string, unknown>) {
  const request = vi.fn(async (method: string, _params?: Record<string, unknown>) => {
    if (method === 'config/read') {
      return { config: { mcp_servers: loaded }, origins: {} }
    }
    if (method === 'thread/start') {
      return { thread: { id: 'thread-1' } }
    }
    throw new Error(`unexpected ${method}`)
  })
  const startedConfig = (): Record<string, unknown> => {
    const call = request.mock.calls.find(([method]) => method === 'thread/start')
    const config = call?.[1]?.config
    return isPlainObject(config) ? config : {}
  }
  return { rpc: { request, notify: vi.fn() }, startedConfig }
}

async function start(cli: BotToolsCli, loaded: Record<string, unknown>, servers: BotToolServer[]) {
  const server = appServer(loaded)
  const tools = await SessionMcpTools.for(
    relay,
    { bot: { botId: cli.botId, folder: cli.folder }, agent: cli.agent },
    { own: servers }
  )
  // What the launch reads from the account's config.toml before Codex runs.
  const ownerStdioNames = await codexStdioToolNames(cli)
  const opened = await codexThread(server.rpc, cli, tools, ownerStdioNames)
  return { opened, config: server.startedConfig(), ownerStdioNames }
}

const notionUrl = { name: 'notion', url: 'https://mcp.notion.com/mcp' }
const stdioNotion = { command: 'npx', args: ['-y', 'mcp-remote', 'https://mcp.notion.com/mcp'] }

describe('a Codex thread with the bot’s own tools', () => {
  it('leaves out a remote server a project layer runs as a command under its name', async () => {
    // The account's config.toml has no notion; the folder's .codex/config.toml does.
    const { opened, config, ownerStdioNames } = await start(botCli(), { notion: stdioNotion }, [
      notionUrl,
      { name: 'linear', url: 'https://mcp.linear.app/mcp' }
    ])
    expect(ownerStdioNames).toEqual(new Set())
    // Codex merges these keys into the loaded stdio entry and refuses the whole thread.
    expect(config).not.toHaveProperty(['mcp_servers.notion.url'])
    expect(config).toEqual({ 'mcp_servers.linear.url': 'https://mcp.linear.app/mcp' })
    expect(opened).toEqual({ threadId: 'thread-1', leftOut: ['notion'] })
  })

  it('leaves out a remote server the account’s config.toml runs as an inline-table command', async () => {
    const cli = botCli('[mcp_servers]\nnotion = { command = "npx", args = ["-y", "mcp-remote"] }\n')
    const { opened, config, ownerStdioNames } = await start(cli, { notion: stdioNotion }, [
      notionUrl
    ])
    expect(ownerStdioNames).toEqual(new Set())
    expect(config).toEqual({})
    expect(opened.leftOut).toEqual(['notion'])
  })

  it('leaves out a command server whose name the owner’s config has as a URL', async () => {
    const cli = botCli('[mcp_servers.notion]\nurl = "https://mcp.notion.com/mcp"\n')
    const { opened, config } = await start(cli, { notion: { url: 'https://mcp.notion.com/mcp' } }, [
      { name: 'notion', command: 'npx', args: ['-y', 'notion-mcp'] }
    ])
    expect(config).toEqual({})
    expect(opened.leftOut).toEqual(['notion'])
  })

  it('keeps a server of the same kind as the owner’s, as before', async () => {
    const cli = botCli('[mcp_servers.notion]\nurl = "https://old.example/mcp"\n')
    const { opened, config } = await start(cli, { notion: { url: 'https://old.example/mcp' } }, [
      notionUrl
    ])
    expect(config).toEqual({ 'mcp_servers.notion.url': 'https://mcp.notion.com/mcp' })
    expect(opened.leftOut).toEqual([])
  })
})
