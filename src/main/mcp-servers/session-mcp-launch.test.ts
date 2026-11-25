import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _resetSecretStoreForTests, setSecretStore } from '../../shared/secure-storage/secret-store'
import { useBotToolCredentialsRoot } from '../bots/bot-tool-credentials'
import { changeBotToolEntries, writeBotToolServers } from '../bots/bot-tools-file'
import { setMcpServerAgentEnabled } from './mcp-host-list'
import {
  sessionLaunchToolsChanged,
  sessionLaunchToolsOutdated,
  sessionMcpLaunchTools
} from './session-mcp-launch'

const dirs: string[] = []
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
const relay = { grant: async () => ({ origin: 'http://127.0.0.1:4100', token: 'the-token' }) }

beforeEach(() => {
  useBotToolCredentialsRoot(tempDir('mcp-credentials-'))
  setSecretStore({
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(text, 'utf8'),
    decryptString: (cipher) => cipher.toString('utf8'),
    describeProtectionGap: () => null
  })
})
afterEach(() => {
  delete process.env.ORCA_MCP_SERVERS
  useBotToolCredentialsRoot(null)
  _resetSecretStoreForTests()
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const linear = { name: 'linear', command: 'npx', args: ['linear-mcp'] }
const postgres = { name: 'postgres', command: 'npx', args: ['pg-mcp'] }
const notion = { name: 'notion', command: 'npx', args: ['host-notion'] }
const sentry = { name: 'sentry', url: 'https://mcp.sentry.dev/mcp', credential: 'cred-sentry-1' }

/** A host list: linear off for Codex, postgres only in repo-1, notion and sentry everywhere. */
async function hostList(): Promise<string> {
  const folder = tempDir('mcp-host-list-')
  await changeBotToolEntries(folder, () => [
    { server: linear, extras: { id: 'id-linear-1', agentsOff: ['codex'] } },
    {
      server: postgres,
      extras: { id: 'id-postgres-1', workspaces: { later: false, on: ['repo-1'], off: [] } }
    },
    { server: notion, extras: { id: 'id-notion-1' } },
    { server: sentry, extras: { id: 'id-sentry-1' } }
  ])
  return folder
}

const session = (provider: string, workspaceId: string) => ({
  provider,
  location: { workspaceId }
})

describe('the MCP servers a chat launches with', () => {
  it('adds nothing from the host list while the switch is off, even to a bot that opted in', async () => {
    const hostFolder = await hostList()
    const botFolder = tempDir('bot-home-')
    await writeBotToolServers(botFolder, [{ name: 'notion', command: 'npx', args: ['bot-notion'] }])
    const chat = await sessionMcpLaunchTools(null, session('claude', 'repo-1::/r'), '/r', {
      relay,
      hostFolder
    })
    expect(chat.tools.servers).toEqual([])
    expect(chat.tools.env).toEqual({})
    expect(chat.launched).toBeNull()

    const bot = await sessionMcpLaunchTools(
      { id: 'scout', hostMcpServers: true },
      session('claude', 'folder:h'),
      botFolder,
      {
        relay,
        hostFolder
      }
    )
    expect(bot.tools.servers).toEqual([{ name: 'notion', command: 'npx', args: ['bot-notion'] }])
    expect(bot.tools.env).toEqual({ ORCA_BOT_TOOLS_TOKEN: 'the-token' })
    expect(bot.launched?.host).toBeNull()
  })

  it('gives each session the servers on for its agent and workspace, and a bot its own first', async () => {
    process.env.ORCA_MCP_SERVERS = '1'
    const hostFolder = await hostList()
    const names = async (provider: string, workspaceId: string) =>
      (
        await sessionMcpLaunchTools(null, session(provider, workspaceId), '/w', {
          relay,
          hostFolder
        })
      ).tools.servers.map((server) => server.name)

    expect(await names('claude', 'repo-1::/work/orca')).toEqual([
      'linear',
      'postgres',
      'notion',
      'sentry'
    ])
    expect(await names('codex', 'repo-1::/work/orca')).toEqual(['postgres', 'notion', 'sentry'])
    expect(await names('claude', 'repo-2::/work/docs')).toEqual(['linear', 'notion', 'sentry'])
    expect(await names('claude', 'folder:scratch')).toEqual(['linear', 'notion', 'sentry'])

    // A server Orca holds the values for goes through the relay under the host's token, never a bot's.
    const chat = await sessionMcpLaunchTools(null, session('claude', 'repo-2::/d'), '/d', {
      relay,
      hostFolder
    })
    expect(chat.tools.servers.at(-1)).toEqual({
      name: 'sentry',
      url: 'http://127.0.0.1:4100/mcp-servers/cred-sentry-1/mcp',
      transport: 'http',
      headers: { authorization: 'Bearer ${ORCA_MCP_TOKEN}' }
    })
    expect(chat.tools.env).toEqual({ ORCA_MCP_TOKEN: 'the-token' })

    const botFolder = tempDir('bot-home-')
    const own = { name: 'notion', command: 'npx', args: ['bot-notion'] }
    await writeBotToolServers(botFolder, [own])
    const launchBot = (hostMcpServers: boolean) =>
      sessionMcpLaunchTools(
        { id: 'scout', hostMcpServers },
        session('claude', 'folder:h'),
        botFolder,
        {
          relay,
          hostFolder
        }
      )
    // The bot can write its own home: a key it puts in its tools file opts in nothing.
    await changeBotToolEntries(botFolder, (entries) => entries, {
      topLevel: (file) => ({ ...file, hostMcpServers: true })
    })
    expect((await launchBot(false)).tools.servers).toEqual([own])

    const opted = await launchBot(true)
    // Its home isn't a user workspace, so postgres comes too; its own notion wins the name.
    expect(opted.tools.servers.map((server) => server.name)).toEqual([
      'notion',
      'linear',
      'postgres',
      'sentry'
    ])
    expect(opted.tools.servers[0]).toEqual(own)
    expect(opted.tools.env).toEqual({ ORCA_BOT_TOOLS_TOKEN: 'the-token' })
  })

  it('restarts a running chat only when a server it got, or would get now, changes', async () => {
    process.env.ORCA_MCP_SERVERS = '1'
    const hostFolder = await hostList()
    const { launched } = await sessionMcpLaunchTools(null, session('claude', 'repo-2::/d'), '/d', {
      relay,
      hostFolder
    })
    if (!launched) {
      throw new Error('a chat that got host servers records what it launched with')
    }
    // The agent's own notion won the name, so the chat took linear and sentry only.
    const delivered = new Set(['linear', 'sentry'])

    // postgres is on only in repo-1, and notion was never this chat's: neither edit restarts it.
    await setMcpServerAgentEnabled('id-postgres-1', 'claude', false, hostFolder)
    await setMcpServerAgentEnabled('id-notion-1', 'claude', false, hostFolder)
    expect(sessionLaunchToolsOutdated(launched)).toBe(true)
    expect(await sessionLaunchToolsChanged(launched, delivered)).toBe(false)
    expect(sessionLaunchToolsOutdated(launched)).toBe(false)
    // An agent that ignores a session's servers never restarts for the list.
    await setMcpServerAgentEnabled('id-linear-1', 'claude', false, hostFolder)
    const ignoring = { ...launched, host: launched.host && { ...launched.host } }
    expect(await sessionLaunchToolsChanged(ignoring, 'ignored')).toBe(false)

    expect(await sessionLaunchToolsChanged(launched, delivered)).toBe(true)
  })
})
