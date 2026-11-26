// Guards PR #49171: each call the relay makes, and each token it saves, opens the one
// credential it is for, not every credential the bot has saved.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  _resetSecretStoreForTests,
  setSecretStore
} from '../../../shared/secure-storage/secret-store'
import { commitBotToolOAuth, useBotToolCredentialsRoot } from '../bot-tool-credentials'
import { writeBotToolServers } from '../bot-tools-file'
import { botToolsPath } from '../bot-tools-path'
import { botToolCredentialSource } from './bot-tool-credential-source'

let opened = 0
const dirs: string[] = []
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

beforeEach(() => {
  useBotToolCredentialsRoot(tempDir('relay-perf-credentials-'))
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

/** A bot with `count` saved-header tools and one tool Orca signed in to; answers its folder. */
async function botWithTools(count: number): Promise<string> {
  const folder = tempDir('relay-perf-')
  await writeBotToolServers(
    folder,
    Array.from({ length: count }, (_, i) => ({
      name: `server-${i}`,
      url: `https://mcp-${i}.example.com/mcp`,
      transport: 'http' as const,
      headers: { authorization: `secret-${i}` }
    }))
  )
  const url = 'https://app.example.com/mcp'
  commitBotToolOAuth(folder, 'signed-in', () => ({
    url,
    grant: 1,
    record: { resource: url, tokens: { access_token: 'token', token_type: 'Bearer' } }
  }))
  const file = JSON.parse(readFileSync(botToolsPath(folder), 'utf8'))
  file.servers.push({ name: 'app', url, transport: 'http', credential: 'signed-in' })
  writeFileSync(botToolsPath(folder), JSON.stringify(file))
  return folder
}

async function opensPerCall(count: number, signedIn: boolean): Promise<number> {
  const folder = await botWithTools(count)
  const file = JSON.parse(readFileSync(botToolsPath(folder), 'utf8'))
  const credentialId = signedIn ? 'signed-in' : file.servers[0].credential
  opened = 0
  const answer = await botToolCredentialSource()({
    host: 'local',
    folder,
    credentialId,
    signal: new AbortController().signal
  })
  expect(answer).toMatchObject({
    kind: 'ready',
    headers: { authorization: signedIn ? 'Bearer token' : 'secret-0' }
  })
  return opened
}

it('opens one credential per relay call, however many the bot has saved', async () => {
  expect(await opensPerCall(10, false)).toBe(1)
  expect(await opensPerCall(100, false)).toBe(1)
  expect(await opensPerCall(10, true)).toBe(1)
  expect(await opensPerCall(100, true)).toBe(1)
})

// A refreshed token commits one sign-in; every other credential's envelope is kept unopened.
it('opens only the committed sign-in when a refresh saves its tokens', async () => {
  const opensPerCommit = async (count: number) => {
    const folder = await botWithTools(count)
    opened = 0
    commitBotToolOAuth(folder, 'signed-in', (current) => ({
      url: current!.url,
      grant: current!.grant,
      record: { ...current!.record, tokens: { access_token: 'next', token_type: 'Bearer' } }
    }))
    return opened
  }
  expect(await opensPerCommit(10)).toBe(1)
  expect(await opensPerCommit(100)).toBe(1)
})
