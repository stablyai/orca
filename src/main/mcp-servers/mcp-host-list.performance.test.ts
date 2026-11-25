// Guards PR #49123: listing or checking a host's MCP servers or a bot's tools, or flipping one server's
// switch, opens each saved credential a fixed number of times, not once per credentialed server. A
// switch already where it's set writes nothing, and a paste of many servers is one write.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { _resetSecretStoreForTests, setSecretStore } from '../../shared/secure-storage/secret-store'
import { useBotToolCredentialsRoot } from '../bots/bot-tool-credentials'
import { botToolProblems, listBotTools } from '../bots/bot-tools-host'
import { writeBotToolServers } from '../bots/bot-tools-file'
import { botToolsEpoch } from '../bots/bot-tools-revision'
import { ALL_MCP_SERVER_WORKSPACES } from '../../shared/mcp-servers/mcp-servers'
import { listMcpServers, setMcpServerAgentEnabled, setMcpServerWorkspaces } from './mcp-host-list'
import { addMcpServers } from './mcp-host-list-add'

let opened = 0
const dirs: string[] = []
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

beforeEach(() => {
  useBotToolCredentialsRoot(tempDir('mcp-host-perf-credentials-'))
  setSecretStore({
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(`sealed(${text})`, 'utf8'),
    decryptString: (cipher) => {
      opened += 1
      return cipher.toString('utf8').replace(/^sealed\((.*)\)$/, '$1')
    },
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

const withHeaders = (count: number, value: string) =>
  Array.from({ length: count }, (_, i) => ({
    name: `server-${i}`,
    url: `https://mcp-${i}.example.com/mcp`,
    transport: 'http' as const,
    headers: { authorization: `${value}-${i}` }
  }))

/** A host list of `count` servers with saved header values, each one credential in the store. */
async function credentialedList(count: number): Promise<string> {
  const folder = tempDir('mcp-host-perf-')
  await writeBotToolServers(folder, withHeaders(count, 'secret'))
  // The first list gives each server its id; what's counted is every list after it.
  await listMcpServers(folder)
  return folder
}

async function opensFor(count: number, work: (folder: string) => Promise<unknown>) {
  const folder = await credentialedList(count)
  opened = 0
  await work(folder)
  return opened
}

// The list's read of the file, and one read for every server's sign-in.
it('opens each credential twice per list, however many servers hold one', async () => {
  const list = (folder: string) => listMcpServers(folder)
  expect(await opensFor(10, list)).toBe(20)
  expect(await opensFor(100, list)).toBe(200)
})

// The write's read, its sign-in check and the answer's read; the answer's sign-in opens only its own.
it('opens each credential three times per switch, plus the switched one', async () => {
  const flip = async (folder: string) => {
    const [first] = await listMcpServers(folder)
    opened = 0
    await setMcpServerAgentEnabled(first!.id, 'claude', false, folder)
  }
  expect(await opensFor(10, flip)).toBe(31)
  expect(await opensFor(100, flip)).toBe(301)
})

// Each write moves the list's epoch, which tells every client to re-read it; these move it 0 times.
// Each call still opens each credential four times: the write's read and sign-in check, and its answer.
it('writes nothing for a switch already where it is set', async () => {
  const writes = new Map<number, number>()
  const again = (count: number) => async (folder: string) => {
    const [first] = await listMcpServers(folder)
    await setMcpServerAgentEnabled(first!.id, 'claude', false, folder)
    const epoch = botToolsEpoch(folder)
    opened = 0
    await setMcpServerAgentEnabled(first!.id, 'claude', false, folder)
    await setMcpServerAgentEnabled(first!.id, 'codex', true, folder)
    await setMcpServerWorkspaces(first!.id, ALL_MCP_SERVER_WORKSPACES, { folder })
    writes.set(count, botToolsEpoch(folder) - epoch)
  }
  expect(await opensFor(10, again(10))).toBe(120)
  expect(await opensFor(100, again(100))).toBe(1200)
  expect(Object.fromEntries(writes)).toEqual({ 10: 0, 100: 0 })
})

// The write's read and sign-in check, and one read and sign-in for every server it answers.
it('adds a paste of many servers in one write and one read back', async () => {
  const writes = new Map<number, number>()
  const paste = (count: number) => async (folder: string) => {
    const epoch = botToolsEpoch(folder)
    const servers = Array.from({ length: count }, (_, i) => ({
      name: `command-${i}`,
      command: 'echo',
      args: []
    }))
    expect(await addMcpServers(servers, { nameGiven: false }, folder)).toHaveLength(count)
    writes.set(count, botToolsEpoch(folder) - epoch)
  }
  expect(await opensFor(10, paste(10))).toBe(40)
  expect(await opensFor(100, paste(100))).toBe(400)
  expect(Object.fromEntries(writes)).toEqual({ 10: 1, 100: 1 })
})

// A bot with no agent CLI of its own, so nothing outside the test folders is read or started.
const home = (folder: string) => ({
  botId: 'bot-1',
  folder,
  signInFolder: folder,
  otherBotFolders: [],
  agent: 'opencode' as const
})

it("opens each credential twice per bot's tools list", async () => {
  const list = (folder: string) => listBotTools(home(folder))
  expect(await opensFor(10, list)).toBe(20)
  expect(await opensFor(100, list)).toBe(200)
})

// The file's read, and one read that tells each server with a credential whether Orca signs in to it.
it('opens each credential twice per tools check', async () => {
  const check = (folder: string) => botToolProblems(home(folder))
  expect(await opensFor(10, check)).toBe(20)
  expect(await opensFor(100, check)).toBe(200)
})

// The file's read, one read for every old value kept for a rollback, and the store's own write.
it('opens each credential a fixed number of times per write that replaces every saved value', async () => {
  const replaceAll = (count: number) => (folder: string) =>
    writeBotToolServers(folder, withHeaders(count, 'rotated'))
  expect(await opensFor(10, replaceAll(10))).toBe(30)
  expect(await opensFor(100, replaceAll(100))).toBe(300)
})
