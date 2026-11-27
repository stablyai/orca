import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { _resetSecretStoreForTests, setSecretStore } from '../../shared/secure-storage/secret-store'
import { SessionMcpTools } from '../mcp-servers/session-mcp-tools'
import {
  commitBotToolOAuth,
  newBotToolCredentialId,
  useBotToolCredentialsRoot
} from './bot-tool-credentials'
import { codexBotToolsThreadConfig } from './bot-tools-codex'
import { addBotTool, botToolProblems, type BotToolsHome } from './bot-tools-host'

const relay = { grant: async () => ({ origin: 'http://127.0.0.1:1', token: 'token' }) }
const launch = { bot: { botId: 'bot', folder: '/bot' }, agent: 'codex' }

const dirs: string[] = []
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  useBotToolCredentialsRoot(null)
  _resetSecretStoreForTests()
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('codexBotToolsThreadConfig', () => {
  it("leaves out a url server named like the owner's stdio server, since Codex would merge the two", async () => {
    const tools = await SessionMcpTools.for(relay, launch, {
      own: [
        { name: 'notion', url: 'https://mcp.notion.com/mcp' },
        { name: 'docs', command: 'npx', args: ['docs-mcp'] }
      ]
    })

    expect(codexBotToolsThreadConfig(tools, new Set(['notion', 'docs']))).toEqual({
      'mcp_servers.docs.command': 'npx',
      'mcp_servers.docs.args': ['docs-mcp']
    })
  })
})

describe('botToolProblems on Codex', () => {
  it("fails each url tool named like the owner's stdio server, even one Orca signs in to, without starting Codex", async () => {
    useBotToolCredentialsRoot(tempDir('bot-tool-credentials-'))
    setSecretStore({
      isEncryptionAvailable: () => true,
      encryptString: (text) => Buffer.from(text, 'utf8'),
      decryptString: (cipher) => cipher.toString('utf8'),
      describeProtectionGap: () => null
    })
    const folder = tempDir('bot-folder-')
    const accountHome = tempDir('codex-home-')
    const cli: BotToolsHome = {
      botId: 'bot',
      folder,
      signInFolder: folder,
      otherBotFolders: [],
      agent: 'codex',
      command: join(folder, 'no-codex-here'),
      prefixArgs: [],
      env: {},
      accountHome
    }
    const notion = 'https://mcp.notion.com/mcp'
    const id = newBotToolCredentialId()
    await addBotTool(
      cli,
      { name: 'notion', url: notion, transport: 'http', credential: id },
      new Map([[id, { url: notion, signIn: true as const }]])
    )
    commitBotToolOAuth(folder, id, (current) => ({
      url: notion,
      grant: current!.grant + 1,
      record: { resource: notion, tokens: { access_token: 'access', token_type: 'bearer' } }
    }))
    await addBotTool(cli, { name: 'linear', url: 'https://mcp.linear.app/mcp', transport: 'http' })
    writeFileSync(
      join(accountHome, 'config.toml'),
      '[mcp_servers.notion]\ncommand = "npx"\n\n[mcp_servers.linear]\ncommand = "npx"\n'
    )

    const taken = (name: string) => ({
      kind: 'failed',
      detail: expect.stringContaining(`Codex already has a local tool named ${name}`)
    })
    expect(await botToolProblems(cli)).toEqual({ notion: taken('notion'), linear: taken('linear') })
  })
})
