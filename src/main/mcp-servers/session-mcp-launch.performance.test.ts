// Guards STA-18220: one host-list write advances the epoch for every running chat, and each chat's
// next input compared by rereading the list and opening the whole credential store twice. However many
// warm chats compare after one write, the list and the store are read once.
import type * as Fs from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { _resetSecretStoreForTests, setSecretStore } from '../../shared/secure-storage/secret-store'
import { botToolCredentialsPath, useBotToolCredentialsRoot } from '../bots/bot-tool-credentials'
import { botToolsPath } from '../bots/bot-tools-path'
import { changeBotToolEntries } from '../bots/bot-tools-file'
import { setMcpServerAgentEnabled } from './mcp-host-list'
import { sessionLaunchToolsChanged, sessionMcpLaunchTools } from './session-mcp-launch'

const reads = vi.hoisted((): { paths: string[] } => ({ paths: [] }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>()
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      reads.paths.push(String(args[0]))
      return actual.readFileSync(...args)
    }
  }
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      reads.paths.push(String(args[0]))
      return actual.readFile(...args)
    }
  }
})

const dirs: string[] = []
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
const relay = { grant: async () => ({ origin: 'http://127.0.0.1:4100', token: 'the-token' }) }

beforeEach(() => {
  process.env.ORCA_MCP_SERVERS = '1'
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

// List and credential-store reads for `chats` warm chats' next inputs after one unrelated write.
async function readsAfterOneWrite(chats: number): Promise<{ list: number; store: number }> {
  const folder = tempDir('mcp-host-list-')
  const credentials = new Map(
    Array.from({ length: 5 }, (_, i) => [
      `cred-${i}-abcdefgh`,
      { url: `https://mcp.example.com/${i}`, headers: { authorization: `Bearer secret-${i}` } }
    ])
  )
  await changeBotToolEntries(
    folder,
    () => [
      ...[...credentials].map(([id, { url }], i) => ({
        server: { name: `remote-${i}`, url, credential: id },
        extras: { id: `id-remote-${i}` }
      })),
      {
        server: { name: 'local', command: 'npx', args: ['local-mcp'] },
        extras: { id: 'id-local-1' }
      }
    ],
    { credentials }
  )
  const launched = await Promise.all(
    Array.from({ length: chats }, async () => {
      const chat = await sessionMcpLaunchTools(
        null,
        { provider: 'claude', location: { workspaceId: 'repo-1::/r' } },
        '/r',
        { relay, hostFolder: folder }
      )
      if (!chat.launched) {
        throw new Error('a chat that got host servers records what it launched with')
      }
      return { launched: chat.launched, delivered: new Set(chat.tools.hostNames) }
    })
  )
  await setMcpServerAgentEnabled('id-local-1', 'codex', false, folder)
  reads.paths.length = 0
  for (const chat of launched) {
    expect(await sessionLaunchToolsChanged(chat.launched, chat.delivered)).toBe(false)
  }
  const count = (path: string) => reads.paths.filter((read) => read === path).length
  return { list: count(botToolsPath(folder)), store: count(botToolCredentialsPath(folder)) }
}

it('reads the host list and its credential store once per write, not once per warm chat', async () => {
  expect(await readsAfterOneWrite(10)).toEqual({ list: 1, store: 1 })
  expect(await readsAfterOneWrite(100)).toEqual({ list: 1, store: 1 })
})
