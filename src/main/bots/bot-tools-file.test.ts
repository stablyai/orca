import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _resetSecretStoreForTests, setSecretStore } from '../../shared/secure-storage/secret-store'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import {
  botToolCredentialsPath,
  readBotToolCredential,
  useBotToolCredentialsRoot
} from './bot-tool-credentials'
import {
  botSessionToolServers,
  botToolsPath,
  changeBotToolServers,
  currentBotToolsRevision,
  readBotToolServers,
  readBotToolsSnapshot,
  writeBotToolServers
} from './bot-tools-file'
import { advanceBotToolsEpoch, botToolsEpoch } from './bot-tools-revision'

const dirs: string[] = []
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

beforeEach(() => {
  useBotToolCredentialsRoot(tempDir('bot-tool-credentials-'))
  setSecretStore({
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(`sealed(${text})`, 'utf8'),
    decryptString: (cipher) => cipher.toString('utf8').replace(/^sealed\((.*)\)$/, '$1'),
    describeProtectionGap: () => null
  })
})
afterEach(() => {
  useBotToolCredentialsRoot(null)
  _resetSecretStoreForTests()
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const notion = { name: 'notion', url: 'https://mcp.notion.com/mcp' }
const SECRET = 'sk-live-secret-value'
const relay = {
  grant: async () => ({ origin: 'http://127.0.0.1:4100', token: 'bot-token' })
}

describe("a bot's tools file", () => {
  it("gives its servers and token to any agent's session in the bot's home folder, and only there", async () => {
    const folder = tempDir('bot-tools-file-')
    await writeBotToolServers(folder, [notion])
    expect(await readBotToolServers(folder)).toEqual([notion])
    const bots = [{ id: 'scout', folderWorkspaceId: 'scout-home' }]
    const home = folderWorkspaceKey('scout-home')
    const record = (provider: string, workspaceId: string) => ({
      provider,
      location: { workspaceId }
    })
    const launch = async (provider: string, workspaceId: string) =>
      (await botSessionToolServers(bots, record(provider, workspaceId), folder, relay)).tools
    for (const agent of ['claude', 'codex', 'grok', 'opencode', 'omp', 'pi', 'antigravity']) {
      const tools = await launch(agent, home)
      expect(tools.servers).toEqual([notion])
      expect({ ...tools.env, ...tools.commandEnv }).toEqual({ ORCA_BOT_TOOLS_TOKEN: 'bot-token' })
    }
    const elsewhere = await launch('grok', 'repo-1')
    expect(elsewhere.servers).toEqual([])
    expect({ ...elsewhere.env, ...elsewhere.commandEnv }).toEqual({})
  })

  it('keeps header values out of the file, sealed in the host store bound to the address', async () => {
    const folder = tempDir('bot-tools-file-')
    await writeBotToolServers(folder, [{ ...notion, headers: { authorization: SECRET } }])
    const text = readFileSync(botToolsPath(folder), 'utf8')
    expect(text).not.toContain(SECRET)
    const [server] = await readBotToolServers(folder)
    expect(server).toMatchObject({ name: 'notion', url: notion.url })
    expect(server && 'headers' in server ? server.headers : undefined).toBeUndefined()
    const id = server && 'credential' in server ? server.credential : undefined
    expect(id).toBeTruthy()
    expect(readFileSync(botToolCredentialsPath(folder), 'utf8')).not.toContain(SECRET)
    expect(readBotToolCredential(folder, id!)).toEqual({
      url: notion.url,
      headers: { authorization: SECRET }
    })
  })

  it('moves values an older Orca left inline the first time the file is read', async () => {
    const folder = tempDir('bot-tools-file-')
    mkdirSync(join(folder, '.orca'), { recursive: true })
    writeFileSync(
      botToolsPath(folder),
      JSON.stringify({
        servers: [{ ...notion, transport: 'http', headers: { 'x-api-key': SECRET } }]
      })
    )
    const [server] = await readBotToolServers(folder)
    expect(readFileSync(botToolsPath(folder), 'utf8')).not.toContain(SECRET)
    const id = server && 'credential' in server ? server.credential : ''
    expect(readBotToolCredential(folder, id!)?.headers).toEqual({ 'x-api-key': SECRET })
    // Read again: nothing left to move, the same credential stays.
    expect(await readBotToolServers(folder)).toEqual([server])
  })

  it("drops a removed tool's saved values", async () => {
    const folder = tempDir('bot-tools-file-')
    await writeBotToolServers(folder, [{ ...notion, headers: { authorization: SECRET } }])
    const [server] = await readBotToolServers(folder)
    const id = server && 'credential' in server ? server.credential! : ''
    await changeBotToolServers(folder, () => [])
    expect(readBotToolCredential(folder, id)).toBeNull()
  })

  it('hands a Claude launch the relay address and an env reference, never the value', async () => {
    const folder = tempDir('bot-tools-file-')
    await writeBotToolServers(folder, [{ ...notion, headers: { authorization: SECRET } }])
    const bots = [{ id: 'scout', folderWorkspaceId: 'scout-home' }]
    const launch = async (provider: string) =>
      (
        await botSessionToolServers(
          bots,
          { provider, location: { workspaceId: folderWorkspaceKey('scout-home') } },
          folder,
          relay
        )
      ).tools
    const claude = await launch('claude')
    const [server] = await readBotToolServers(folder)
    const id = server && 'credential' in server ? server.credential : ''
    expect(claude.servers).toEqual([
      {
        name: 'notion',
        url: `http://127.0.0.1:4100/bot-tools/${id}/mcp`,
        transport: 'http',
        headers: { authorization: 'Bearer ${ORCA_BOT_TOOLS_TOKEN}' }
      }
    ])
    expect(claude.env).toEqual({ ORCA_BOT_TOOLS_TOKEN: 'bot-token' })
    const codex = await launch('codex')
    expect(codex.servers[0]).toMatchObject({ headers: { authorization: 'Bearer bot-token' } })
    expect(codex.env).toEqual({})
    expect(JSON.stringify([claude, codex])).not.toContain(SECRET)
  })
})

describe('an edited tool', () => {
  it('keeps its credential id, so a running chat’s relay address gets the new value', async () => {
    const folder = tempDir('bot-tools-file-')
    await writeBotToolServers(folder, [{ ...notion, headers: { authorization: SECRET } }])
    const [before] = await readBotToolServers(folder)
    const id = before && 'credential' in before ? before.credential! : ''
    await changeBotToolServers(
      folder,
      (servers) =>
        servers.map(() => ({
          name: 'renamed',
          url: notion.url,
          headers: { authorization: 'rotated' }
        })),
      undefined,
      { from: 'notion', to: 'renamed' }
    )
    const [after] = await readBotToolServers(folder)
    expect(after && 'credential' in after ? after.credential : null).toBe(id)
    expect(readBotToolCredential(folder, id)?.headers).toEqual({ authorization: 'rotated' })
  })
})

describe('saving a tool', () => {
  it('changes the editor version on a header-only edit, so a stale editor is refused', async () => {
    const folder = tempDir('bot-tools-file-')
    const tool = { ...notion, transport: 'http' as const }
    await writeBotToolServers(folder, [{ ...tool, headers: { authorization: 'one' } }])
    const before = (await readBotToolsSnapshot(folder)).version
    await changeBotToolServers(folder, () => [{ ...tool, headers: { authorization: 'two' } }])
    const after = (await readBotToolsSnapshot(folder)).version
    expect(after).not.toBe(before)
    await expect(
      changeBotToolServers(folder, () => [{ ...tool, headers: { authorization: 'three' } }], before)
    ).rejects.toThrow('Tools changed')
  })

  it('leaves the saved values as they were when the file write throws', async () => {
    const folder = tempDir('bot-tools-file-')
    await writeBotToolServers(folder, [
      { ...notion, url: 'https://old.test/mcp', headers: { authorization: 'old' } }
    ])
    const [server] = await readBotToolServers(folder)
    const id = server && 'credential' in server ? server.credential! : ''
    chmodSync(join(folder, '.orca'), 0o500)
    try {
      await expect(
        changeBotToolServers(folder, () => [
          { ...notion, url: 'https://new.test/mcp', headers: { authorization: 'new' } }
        ])
      ).rejects.toThrow()
    } finally {
      chmodSync(join(folder, '.orca'), 0o700)
    }
    expect(readBotToolCredential(folder, id)).toEqual({
      url: 'https://old.test/mcp',
      headers: { authorization: 'old' }
    })
  })
})

describe('the tools a chat launched with', () => {
  const bots = [{ id: 'scout', folderWorkspaceId: 'scout-home' }]
  const launch = (
    folder: string,
    provider = 'codex',
    workspaceId = folderWorkspaceKey('scout-home')
  ) => botSessionToolServers(bots, { provider, location: { workspaceId } }, folder, relay)

  it('gives a bot with no tools a revision its first tool changes', async () => {
    const folder = tempDir('bot-tools-revision-')
    const { launched } = await launch(folder)
    expect(launched).not.toBeNull()

    await writeBotToolServers(folder, [notion])

    expect(await currentBotToolsRevision(folder)).not.toBe(launched?.revision)
    expect(botToolsEpoch(folder)).not.toBe(launched?.epoch)
  })

  it('changes the revision when the last tool goes', async () => {
    const folder = tempDir('bot-tools-revision-')
    await writeBotToolServers(folder, [notion])
    const { launched } = await launch(folder)

    await writeBotToolServers(folder, [])

    expect(await currentBotToolsRevision(folder)).not.toBe(launched?.revision)
  })

  it('counts a finished sign-in, and an edit made outside Orca, as a change', async () => {
    const folder = tempDir('bot-tools-revision-')
    await writeBotToolServers(folder, [notion])
    const { launched } = await launch(folder)
    expect(await currentBotToolsRevision(folder)).toBe(launched?.revision)

    advanceBotToolsEpoch(folder)
    expect(await currentBotToolsRevision(folder)).not.toBe(launched?.revision)

    const signedIn = await launch(folder)
    writeFileSync(
      botToolsPath(folder),
      JSON.stringify({ servers: [{ name: 'linear', url: 'https://mcp.linear.app/mcp' }] })
    )
    expect(await currentBotToolsRevision(folder)).not.toBe(signedIn.launched?.revision)
    expect(botToolsEpoch(folder)).toBe(signedIn.launched?.epoch)
  })

  it("records nothing for a chat that is not a bot's", async () => {
    const folder = tempDir('bot-tools-revision-')
    expect((await launch(folder, 'codex', folderWorkspaceKey('repo-1'))).launched).toBeNull()
  })
})
