import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { botToolDraftInput, draftFromServer } from '../../shared/bots/bot-tool-draft'
import { _resetSecretStoreForTests, setSecretStore } from '../../shared/secure-storage/secret-store'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import {
  botToolCredentialsPath,
  commitBotToolOAuth,
  newBotToolCredentialId,
  readBotToolCredential,
  readBotToolOAuth,
  useBotToolCredentialsRoot
} from './bot-tool-credentials'
import { readBotToolDetails } from './bot-tool-details'
import { addBotTool, updateBotTool, type BotToolsHome } from './bot-tools-host'
import { sessionMcpLaunchTools } from '../mcp-servers/session-mcp-launch'
import {
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
  it("gives a session in the bot's home its servers and the bot's token", async () => {
    const folder = tempDir('bot-tools-file-')
    await writeBotToolServers(folder, [notion])
    const { tools } = await sessionMcpLaunchTools(
      { id: 'scout' },
      { provider: 'grok', location: { workspaceId: folderWorkspaceKey('scout-home') } },
      folder,
      { relay }
    )
    expect(tools.servers).toEqual([notion])
    expect(tools.env).toEqual({ ORCA_BOT_TOOLS_TOKEN: 'bot-token' })
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
})

const signedInNotion = async () => {
  const folder = tempDir('bot-tools-file-')
  const home: BotToolsHome = {
    botId: 'bot',
    folder,
    signInFolder: folder,
    otherBotFolders: [],
    agent: 'gemini'
  }
  const id = newBotToolCredentialId()
  await addBotTool(
    home,
    { ...notion, transport: 'http', credential: id },
    new Map([[id, { url: notion.url, signIn: true as const }]])
  )
  const tokens = { access_token: 'access', token_type: 'bearer' }
  commitBotToolOAuth(folder, id, (current) => ({
    url: notion.url,
    grant: current!.grant + 1,
    record: { resource: notion.url, tokens }
  }))
  return { folder, home, id, tokens }
}

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

  it('keeps its Orca sign-in when the editor saves it unchanged', async () => {
    const { folder, home, id, tokens } = await signedInNotion()
    const { version, server } = await readBotToolDetails(folder, 'notion')

    await updateBotTool(home, 'notion', version, botToolDraftInput(draftFromServer(server)))

    const [after] = await readBotToolServers(folder)
    expect(after && 'credential' in after ? after.credential : null).toBe(id)
    expect(readBotToolOAuth(folder, id)?.record.tokens).toEqual(tokens)
  })

  it('keeps its Orca sign-in when a save adding a header row is refused', async () => {
    const { folder, home, id, tokens } = await signedInNotion()
    const { version } = await readBotToolDetails(folder, 'notion')

    await expect(
      updateBotTool(home, 'notion', version, {
        name: 'notion',
        url: notion.url,
        transport: 'http',
        headers: [{ key: 'x-extra', value: 'one' }]
      })
    ).rejects.toThrow('Orca signs in to this tool')

    const [after] = await readBotToolServers(folder)
    expect(after && 'credential' in after ? after.credential : null).toBe(id)
    expect(readBotToolOAuth(folder, id)?.record.tokens).toEqual(tokens)
  })

  it('drops saved header values the editor removed', async () => {
    const folder = tempDir('bot-tools-file-')
    const home: BotToolsHome = {
      botId: 'bot',
      folder,
      signInFolder: folder,
      otherBotFolders: [],
      agent: 'gemini'
    }
    await writeBotToolServers(folder, [{ ...notion, headers: { authorization: SECRET } }])
    const [before] = await readBotToolServers(folder)
    const id = before && 'credential' in before ? before.credential! : ''
    const { version, server } = await readBotToolDetails(folder, 'notion')

    await updateBotTool(
      home,
      'notion',
      version,
      botToolDraftInput({ ...draftFromServer(server), headers: [] })
    )

    const [after] = await readBotToolServers(folder)
    expect(after && 'credential' in after ? after.credential : undefined).toBeUndefined()
    expect(readBotToolCredential(folder, id)).toBeNull()
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

  // Windows ignores folder modes, and the atomic writer retries permission errors there.
  it.skipIf(process.platform === 'win32')(
    'leaves the saved values as they were when the file write throws',
    async () => {
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
    }
  )
})

describe('the tools a chat launched with', () => {
  const launch = (
    folder: string,
    provider = 'codex',
    workspaceId = folderWorkspaceKey('scout-home')
  ) =>
    sessionMcpLaunchTools({ id: 'scout' }, { provider, location: { workspaceId } }, folder, {
      relay
    })

  it('changes the revision when the first tool is added and the last tool is removed', async () => {
    const folder = tempDir('bot-tools-revision-')
    const { launched: empty } = await launch(folder)
    expect(empty).not.toBeNull()

    await writeBotToolServers(folder, [notion])

    const { launched: configured } = await launch(folder)
    expect(configured).not.toBeNull()
    expect(configured?.revision).not.toBe(empty?.revision)
    expect(configured?.epoch).not.toBe(empty?.epoch)

    await writeBotToolServers(folder, [])

    expect(await currentBotToolsRevision(folder)).not.toBe(configured?.revision)
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
})
