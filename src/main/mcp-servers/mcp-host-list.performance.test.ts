// Guards PR #<n>: listing or checking a host's MCP servers or a bot's tools, or flipping one server's
// switch, opens each saved credential a fixed number of times, not once per credentialed server.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { _resetSecretStoreForTests, setSecretStore } from '../../shared/secure-storage/secret-store'
import { useBotToolCredentialsRoot } from '../bots/bot-tool-credentials'
import { botToolProblems, listBotTools } from '../bots/bot-tools-host'
import { writeBotToolServers } from '../bots/bot-tools-file'
import { listMcpServers, setMcpServerAgentEnabled } from './mcp-host-list'

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

/** A host list of `count` servers with saved header values, each one credential in the store. */
async function credentialedList(count: number): Promise<string> {
  const folder = tempDir('mcp-host-perf-')
  await writeBotToolServers(
    folder,
    Array.from({ length: count }, (_, i) => ({
      name: `server-${i}`,
      url: `https://mcp-${i}.example.com/mcp`,
      transport: 'http' as const,
      headers: { authorization: `secret-${i}` }
    }))
  )
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

// The write's read, its sign-in check, and the read and sign-in of the answer it gives back.
it('opens each credential four times per switch', async () => {
  const flip = async (folder: string) => {
    const [first] = await listMcpServers(folder)
    opened = 0
    await setMcpServerAgentEnabled(first!.id, 'claude', false, folder)
  }
  expect(await opensFor(10, flip)).toBe(40)
  expect(await opensFor(100, flip)).toBe(400)
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
