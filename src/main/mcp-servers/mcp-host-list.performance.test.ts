// Guards PR #49123: listing or checking a host's MCP servers or a bot's tools opens each saved
// credential once, not once per credentialed server, and flipping one server's switch opens only its
// own. A switch already where it's set writes nothing, and a paste of many servers is one write.
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

// Each server's sign-in; the file's version, which a list doesn't use, opens none.
it('opens each credential once per list, however many servers hold one', async () => {
  const list = (folder: string) => listMcpServers(folder)
  expect(await opensFor(10, list)).toBe(10)
  expect(await opensFor(100, list)).toBe(100)
})

// The answer's sign-in. The write checks no unchanged server's sign-in, and neither read needs a version.
it('opens only the switched server’s credential per switch', async () => {
  const flip = async (folder: string) => {
    const [first] = await listMcpServers(folder)
    opened = 0
    await setMcpServerAgentEnabled(first!.id, 'claude', false, folder)
  }
  expect(await opensFor(10, flip)).toBe(1)
  expect(await opensFor(100, flip)).toBe(1)
})

// Each write moves the list's epoch, which tells every client to re-read it; these move it 0 times.
// Each call opens only the answer's own credential.
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
  expect(await opensFor(10, again(10))).toBe(3)
  expect(await opensFor(100, again(100))).toBe(3)
  expect(Object.fromEntries(writes)).toEqual({ 10: 0, 100: 0 })
})

// Command servers hold no credential, and nothing else's is opened.
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
  expect(await opensFor(10, paste(10))).toBe(0)
  expect(await opensFor(100, paste(100))).toBe(0)
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

it("opens each credential once per bot's tools list", async () => {
  const list = (folder: string) => listBotTools(home(folder))
  expect(await opensFor(10, list)).toBe(10)
  expect(await opensFor(100, list)).toBe(100)
})

// One read that tells each server with a credential whether Orca signs in to it.
it('opens each credential once per tools check', async () => {
  const check = (folder: string) => botToolProblems(home(folder))
  expect(await opensFor(10, check)).toBe(10)
  expect(await opensFor(100, check)).toBe(100)
})

// One read for every old value kept for a rollback, and the store's own write.
it('opens each credential a fixed number of times per write that replaces every saved value', async () => {
  const replaceAll = (count: number) => (folder: string) =>
    writeBotToolServers(folder, withHeaders(count, 'rotated'))
  expect(await opensFor(10, replaceAll(10))).toBe(20)
  expect(await opensFor(100, replaceAll(100))).toBe(200)
})
