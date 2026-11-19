import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { toClaudeTrustKey } from '../claude/configuration/claude-folder-trust-file'
import { useBotToolCredentialsRoot } from './bot-tool-credentials'
import { ClaudeMirrorScrubs, scrubClaudeToolMirror } from './bot-tool-secret-scrub'
import { readClaudeMirror } from './bot-tools-claude'
import { botToolsPath } from './bot-tools-file'
import type { BotToolsCli } from './bot-tools-host'

const dirs: string[] = []
beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'scrub-credentials-'))
  dirs.push(root)
  useBotToolCredentialsRoot(root)
})
afterEach(() => {
  useBotToolCredentialsRoot(null)
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Stands in for `claude mcp remove --scope local <name>`: drops the server from the folder's mirror.
const FAKE_CLAUDE = `const fs=require('fs');const [,,,,name]=process.argv.slice(1);const file=process.env.CLAUDE_CONFIG_DIR+'/.claude.json';const config=JSON.parse(fs.readFileSync(file,'utf8'));for(const project of Object.values(config.projects??{}))delete project.mcpServers?.[name];fs.writeFileSync(file,JSON.stringify(config))`

describe("scrubbing a bot's saved values out of Claude's config", () => {
  it('moves the file’s inline values and removes the mirror copies, keeping a mirror that holds none', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scrub-bot-'))
    dirs.push(root)
    const folder = join(root, 'bot')
    const accountHome = join(root, 'account')
    const signInFolder = join(root, 'sign-in')
    mkdirSync(join(folder, '.orca'), { recursive: true })
    mkdirSync(accountHome)
    mkdirSync(signInFolder)
    writeFileSync(
      botToolsPath(folder),
      JSON.stringify({
        servers: [
          { name: 'docs', url: 'https://docs.example/mcp', headers: { 'x-api-key': 'sk-legacy' } },
          { name: 'notion', url: 'https://mcp.notion.com/mcp' }
        ]
      })
    )
    writeFileSync(
      join(accountHome, '.claude.json'),
      JSON.stringify({
        projects: {
          [toClaudeTrustKey(signInFolder, process.platform === 'win32' ? 'win32' : 'posix')]: {
            mcpServers: {
              docs: {
                type: 'http',
                url: 'https://docs.example/mcp',
                headers: { 'x-api-key': 'sk-legacy' }
              },
              notion: { type: 'http', url: 'https://mcp.notion.com/mcp' }
            }
          }
        }
      })
    )
    const cli: BotToolsCli = {
      botId: 'bot-1',
      agent: 'claude',
      folder,
      signInFolder,
      command: process.execPath,
      prefixArgs: ['-e', FAKE_CLAUDE, '--'],
      env: { CLAUDE_CONFIG_DIR: accountHome },
      accountHome,
      otherBotFolders: []
    }
    await scrubClaudeToolMirror(cli)
    expect(readFileSync(join(accountHome, '.claude.json'), 'utf8')).not.toContain('sk-legacy')
    expect(readFileSync(botToolsPath(folder), 'utf8')).not.toContain('sk-legacy')
    expect(Object.keys(await readClaudeMirror(accountHome, signInFolder))).toEqual(['notion'])
  })
})

describe('cleanups across Claude accounts', () => {
  it("cleans each account's copy, so a clean account never skips another", async () => {
    const seen: string[] = []
    const scrubs = new ClaudeMirrorScrubs(async (cli) => {
      seen.push(cli.accountHome ?? '')
    })
    const cli = (accountHome: string): BotToolsCli => ({
      botId: 'bot-1',
      agent: 'claude',
      folder: '/bots/bot-1',
      signInFolder: '/sign-in/bot-1',
      command: 'claude',
      prefixArgs: [],
      env: {},
      accountHome,
      otherBotFolders: []
    })
    await scrubs.ensure(cli('/accounts/b'))
    await scrubs.ensure(cli('/accounts/b'))
    await scrubs.ensure(cli('/accounts/a'))
    expect(seen).toEqual(['/accounts/b', '/accounts/a'])
  })

  it('runs a failed cleanup again', async () => {
    let attempts = 0
    const scrubs = new ClaudeMirrorScrubs(async () => {
      attempts += 1
      if (attempts === 1) {
        throw new Error('claude busy')
      }
    })
    const asCli: BotToolsCli = {
      botId: 'bot-1',
      agent: 'claude',
      folder: '',
      signInFolder: '',
      command: '',
      prefixArgs: [],
      env: {},
      accountHome: '/accounts/a',
      otherBotFolders: []
    }
    await expect(scrubs.ensure(asCli)).rejects.toThrow('busy')
    await scrubs.ensure(asCli)
    expect(attempts).toBe(2)
  })
})
