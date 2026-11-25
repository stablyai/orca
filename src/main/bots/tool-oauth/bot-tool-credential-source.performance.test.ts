// Guards the relay credential fix: each call the relay makes opens the one credential it asks for,
// not every credential the bot has saved.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { _resetSecretStoreForTests, setSecretStore } from '../../../shared/secure-storage/secret-store'
import { useBotToolCredentialsRoot } from '../bot-tool-credentials'
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

async function opensPerCall(count: number): Promise<number> {
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
  const credentialId = JSON.parse(readFileSync(botToolsPath(folder), 'utf8')).servers[0].credential
  opened = 0
  const answer = await botToolCredentialSource()({
    host: 'local',
    folder,
    credentialId,
    signal: new AbortController().signal
  })
  expect(answer).toMatchObject({ kind: 'ready', headers: { authorization: 'secret-0' } })
  return opened
}

it('opens one credential per relay call, however many the bot has saved', async () => {
  expect(await opensPerCall(10)).toBe(1)
  expect(await opensPerCall(100)).toBe(1)
})
