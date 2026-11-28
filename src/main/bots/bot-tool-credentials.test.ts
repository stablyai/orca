import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTreeSync } from '../../shared/file-write/windows-transient-lock-removal'
import { _resetSecretStoreForTests, getSecretStore } from '../../shared/secure-storage/secret-store'
import {
  botToolCredentialsPath,
  changeBotToolCredentials,
  commitBotToolOAuth,
  readBotToolCredential,
  useBotToolCredentialsRoot
} from './bot-tool-credentials'
import { botToolCredentialSource } from './tool-oauth/bot-tool-credential-source'
import { installFakeSealingStore, writeToolsFile } from './tool-relay/bot-tool-relay.test-fixtures'

const SECRET = 'Bearer OWNER_SECRET'
const LINEAR = 'https://mcp.linear.app/mcp'
const ATTACKER = 'https://attacker.example/mcp'
const dirs: string[] = []
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
let root: string

beforeEach(() => {
  root = tempDir('bot-tool-credentials-')
  useBotToolCredentialsRoot(root)
  installFakeSealingStore()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  useBotToolCredentialsRoot(null)
  _resetSecretStoreForTests()
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) {
    removeTreeSync(dir)
  }
})

const plain = (value: unknown) => `plain:${Buffer.from(JSON.stringify(value)).toString('base64')}`
const ask = (folder: string, credentialId: string) =>
  botToolCredentialSource()({
    host: 'local',
    folder,
    credentialId,
    signal: new AbortController().signal
  })

function saveLinear(folder: string): void {
  changeBotToolCredentials(
    folder,
    new Map([['cred-1', { url: LINEAR, headers: { authorization: SECRET } }]])
  )
  writeToolsFile(folder, { 'cred-1': LINEAR })
}

describe("a bot's sealed tool credentials", () => {
  it('keep the address inside the seal, so editing the file cannot re-point the value', async () => {
    const folder = tempDir('bot-')
    saveLinear(folder)
    const path = botToolCredentialsPath(folder)
    expect(readFileSync(path, 'utf8')).not.toContain('linear.app')
    // An unsealed entry naming another address, written by anyone with the file.
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        credentials: {
          'cred-1': plain({
            folder,
            id: 'cred-1',
            entry: { kind: 'headers', url: ATTACKER, headers: { authorization: SECRET } }
          })
        }
      })
    )
    expect(readBotToolCredential(folder, 'cred-1')).toBeNull()
    // Nothing is sent: the row asks for a new sign-in or key instead.
    expect(await ask(folder, 'cred-1')).toEqual({ kind: 'unreadable' })
  })

  it('open only for the folder and id they were sealed for', () => {
    const scout = tempDir('scout-')
    const docs = tempDir('docs-')
    saveLinear(scout)
    // Another bot copies scout's file as its own, and moves the value to another id.
    const text = readFileSync(botToolCredentialsPath(scout), 'utf8')
    writeFileSync(botToolCredentialsPath(docs), text)
    expect(readBotToolCredential(docs, 'cred-1')).toBeNull()
    writeFileSync(botToolCredentialsPath(scout), text.replace('"cred-1"', '"cred-2"'))
    expect(readBotToolCredential(scout, 'cred-2')).toBeNull()
  })

  it('go to the relay only at the address the tools file gives the tool', async () => {
    const folder = tempDir('bot-')
    saveLinear(folder)
    expect(await ask(folder, 'cred-1')).toMatchObject({
      kind: 'ready',
      url: LINEAR,
      headers: { authorization: SECRET }
    })
    writeToolsFile(folder, { 'cred-1': ATTACKER })
    expect(await ask(folder, 'cred-1')).toEqual({ kind: 'missing' })
  })

  it('never unseal a file in the older layout, whatever sealed value it carries', async () => {
    const victim = tempDir('victim-')
    saveLinear(victim)
    // Another bot's whole sealed entry, dropped into an older-layout file pointing at the attacker.
    const stolen = JSON.parse(readFileSync(botToolCredentialsPath(victim), 'utf8')).credentials[
      'cred-1'
    ]
    const folder = tempDir('bot-')
    writeFileSync(
      botToolCredentialsPath(folder),
      JSON.stringify({
        credentials: { x: { kind: 'headers', url: ATTACKER, headers: { leak: stolen } } }
      })
    )
    writeToolsFile(folder, { x: ATTACKER })
    const decrypt = vi.spyOn(getSecretStore(), 'decryptString')
    expect(readBotToolCredential(folder, 'x')).toBeNull()
    expect(await ask(folder, 'x')).toEqual({ kind: 'missing' })
    expect(decrypt).not.toHaveBeenCalled()
  })

  it('refuse saved secrets on a computer with no keyring', () => {
    _resetSecretStoreForTests()
    const folder = tempDir('bot-')
    expect(() => saveLinear(folder)).toThrow('no system keyring')
    expect(() =>
      commitBotToolOAuth(folder, 'cred-2', () => ({
        url: LINEAR,
        grant: 1,
        record: { resource: LINEAR, tokens: { access_token: 'a', token_type: 'Bearer' } }
      }))
    ).toThrow('no system keyring')
    // A hub entry holds no value of its own; Orca adds the key per call.
    changeBotToolCredentials(
      folder,
      new Map([['cred-3', { url: LINEAR, headers: {}, source: 'composio' }]])
    )
    expect(readBotToolCredential(folder, 'cred-3')).toMatchObject({ source: 'composio' })
  })
})
