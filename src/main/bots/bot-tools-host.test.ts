import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addBotTool, type BotToolsCli } from './bot-tools-host'
import { forgetBotTools, removeBotTool } from './bot-tools-removal'
import {
  botToolSignInStatus,
  connectBotTool,
  finishBotToolSignIn,
  forgetBotToolSignIns
} from './bot-tools-sign-in'
import { readBotToolServers, writeBotToolServers } from './bot-tools-file'
import { useBotToolCredentialsRoot } from './bot-tool-credentials'

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

function cliFor(agent: 'claude' | 'codex'): BotToolsCli {
  const root = mkdtempSync(join(tmpdir(), 'bot-tools-host-'))
  dirs.push(root)
  const home = join(root, 'account')
  mkdirSync(home)
  if (agent === 'claude') {
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { github: {} } }))
  } else {
    writeFileSync(
      join(home, 'config.toml'),
      '[mcp_servers.linear]\nurl = "https://mcp.linear.app/mcp"\n'
    )
  }
  return {
    botId: 'bot-1',
    agent,
    folder: join(root, 'bot'),
    signInFolder: join(root, 'sign-in'),
    command: agent,
    prefixArgs: [],
    env: {},
    accountHome: home,
    otherBotFolders: []
  }
}

/** Points the CLI at node, recording each run's arguments in the returned file. */
function recordCalls(cli: BotToolsCli): string {
  const calls = join(cli.folder, '..', 'calls.txt')
  cli.command = process.execPath
  cli.prefixArgs = [
    '-e',
    `require('fs').appendFileSync(${JSON.stringify(calls)}, process.argv.slice(1).join(' ') + '\\n')`
  ]
  return calls
}

const NOTION = { name: 'notion', url: 'https://mcp.notion.com/mcp' }

describe("a bot's own tools", () => {
  it("refuse a name the owner's own Claude Code or Codex server already uses, or the bot's", async () => {
    const claude = cliFor('claude')
    await expect(
      addBotTool(claude, { name: 'github', url: 'https://x.example/mcp' })
    ).rejects.toThrow('Your Claude Code already has a tool named github')
    const codex = cliFor('codex')
    await expect(
      addBotTool(codex, { name: 'linear', url: 'https://x.example/mcp' })
    ).rejects.toThrow('Your Codex already has a tool named linear')
    await addBotTool(codex, { name: 'notion', url: 'https://mcp.notion.com/mcp' })
    await expect(
      addBotTool(codex, { name: 'notion', url: 'https://y.example/mcp' })
    ).rejects.toThrow('This bot already has a tool named notion')
    expect((await readBotToolServers(codex.folder)).map((server) => server.name)).toEqual([
      'notion'
    ])
  })

  it('takes a pasted address only for a sign-in this host started', async () => {
    await expect(
      finishBotToolSignIn(cliFor('codex'), 'notion', 'http://127.0.0.1:5555/callback?code=x')
    ).rejects.toThrow("That isn't the address this sign-in ends on")
  })

  it("signs a deleted bot's tools out and drops its sign-in folder", async () => {
    for (const agent of ['claude', 'codex'] as const) {
      const cli = cliFor(agent)
      const calls = recordCalls(cli)
      await writeBotToolServers(cli.folder, [NOTION])
      mkdirSync(cli.signInFolder, { recursive: true })
      await forgetBotTools(cli)
      expect(existsSync(cli.signInFolder)).toBe(false)
      expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual(
        agent === 'claude'
          ? ['mcp logout notion', 'mcp remove --scope local notion']
          : ['mcp logout notion -c mcp_servers.notion.url="https://mcp.notion.com/mcp"']
      )
    }
  })

  it('keeps the sign-in another bot shares, by name and URL, when one bot removes the tool', async () => {
    for (const agent of ['claude', 'codex'] as const) {
      const cli = cliFor(agent)
      const calls = recordCalls(cli)
      const other = join(cli.folder, '..', 'other-bot')
      cli.otherBotFolders = [other]
      await writeBotToolServers(cli.folder, [NOTION])
      await writeBotToolServers(other, [NOTION])
      mkdirSync(cli.signInFolder, { recursive: true })
      await removeBotTool(cli, 'notion')
      // Claude still drops this bot's own copy; nothing signs out.
      expect(existsSync(calls) ? readFileSync(calls, 'utf8').trim() : '').toBe(
        agent === 'claude' ? 'mcp remove --scope local notion' : ''
      )
      expect(await readBotToolServers(cli.folder)).toEqual([])
    }
  })

  it('signs out when the other bot has the name at another URL', async () => {
    const cli = cliFor('codex')
    const calls = recordCalls(cli)
    const other = join(cli.folder, '..', 'other-bot')
    cli.otherBotFolders = [other]
    await writeBotToolServers(cli.folder, [NOTION])
    await writeBotToolServers(other, [{ name: 'notion', url: 'https://elsewhere.example/mcp' }])
    await removeBotTool(cli, 'notion')
    expect(readFileSync(calls, 'utf8')).toContain('mcp logout notion')
  })

  it('reports no sign-in for a tool this host never started one for', () => {
    expect(botToolSignInStatus('bot-1', 'notion')).toBe('none')
  })

  it('reads pending from the moment Connect starts, never an earlier try, until this one ends', async () => {
    const cli = cliFor('codex')
    await writeBotToolServers(cli.folder, [NOTION])
    // Stands in for a Codex that exits before naming a page.
    cli.command = process.execPath
    cli.prefixArgs = ['-e', 'setTimeout(() => {}, 300)']
    await expect(connectBotTool('bot-slow', 'notion', async () => cli)).rejects.toThrow()
    expect(botToolSignInStatus('bot-slow', 'notion')).toBe('failed')

    const resolved = Promise.withResolvers<BotToolsCli>()
    const again = connectBotTool('bot-slow', 'notion', () => resolved.promise)
    expect(botToolSignInStatus('bot-slow', 'notion')).toBe('pending')
    resolved.resolve(cli)
    await expect(again).rejects.toThrow()
    expect(botToolSignInStatus('bot-slow', 'notion')).toBe('failed')

    forgetBotToolSignIns('bot-slow')
    expect(botToolSignInStatus('bot-slow', 'notion')).toBe('none')
  })
})
