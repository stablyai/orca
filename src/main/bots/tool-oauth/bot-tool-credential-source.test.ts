import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  _resetSecretStoreForTests,
  setSecretStore
} from '../../../shared/secure-storage/secret-store'
import { commitBotToolOAuth, useBotToolCredentialsRoot } from '../bot-tool-credentials'
import { writeToolsFile } from '../tool-relay/bot-tool-relay.test-fixtures'
import { botToolCredentialSource } from './bot-tool-credential-source'

const URL = 'https://mcp.linear.app/mcp'
const dirs: string[] = []

/** A keychain whose seals open only under the same key, as another keychain's don't. */
function useKeychain(key: string): void {
  setSecretStore({
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(`${key}:${text}`, 'utf8'),
    decryptString: (cipher) => {
      const text = cipher.toString('utf8')
      if (!text.startsWith(`${key}:`)) {
        throw new Error('wrong key')
      }
      return text.slice(key.length + 1)
    },
    describeProtectionGap: () => null
  })
}

function folderWithSignedOutTool(id: string): string {
  const folder = mkdtempSync(join(tmpdir(), 'credential-source-'))
  dirs.push(folder)
  writeToolsFile(folder, { [id]: URL })
  commitBotToolOAuth(folder, id, () => ({ url: URL, grant: 0, record: { resource: URL } }))
  return folder
}

/** What a new sign-in commits over an entry that doesn't open here. */
const replaceUnreadable = (folder: string, id: string) =>
  commitBotToolOAuth(folder, id, () => ({ url: URL, grant: 0, record: { resource: URL } }), {
    replaceUnreadable: true
  })

const ask = (folder: string, credentialId: string) =>
  botToolCredentialSource()({
    host: 'local',
    folder,
    credentialId,
    signal: new AbortController().signal
  })

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'credential-source-store-'))
  dirs.push(root)
  useBotToolCredentialsRoot(root)
  useKeychain('real')
})
afterEach(() => {
  _resetSecretStoreForTests()
  useBotToolCredentialsRoot(null)
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('answers a signed-out sign-in as needing one, never as a missing tool', async () => {
  const folder = folderWithSignedOutTool('RpOrla4iYegm-PsV')
  await expect(ask(folder, 'RpOrla4iYegm-PsV')).resolves.toEqual({ kind: 'sign-in-needed' })
})

it('tells an entry sealed under another keychain from a missing one, and a new sign-in replaces it', async () => {
  useKeychain('mock')
  const folder = folderWithSignedOutTool('RpOrla4iYegm-PsV')
  useKeychain('real')
  await expect(ask(folder, 'RpOrla4iYegm-PsV')).resolves.toEqual({ kind: 'unreadable' })
  // An id the tools file doesn't name is missing, whatever the store holds.
  await expect(ask(folder, 'Le-FBGCC3XgyQUgx')).resolves.toEqual({ kind: 'missing' })

  expect(replaceUnreadable(folder, 'RpOrla4iYegm-PsV')).toMatchObject({ url: URL })
  await expect(ask(folder, 'RpOrla4iYegm-PsV')).resolves.toEqual({ kind: 'sign-in-needed' })
  // One that opens is never replaced.
  expect(replaceUnreadable(folder, 'RpOrla4iYegm-PsV')).toBeUndefined()
})
