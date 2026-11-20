import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { configureServerCredentialVault } from '../credentials/vault/server-credential-vault'
import { openOrcadSecret, sealOrcadSecret } from '../orcad/credentials/orcad-secret-sealing'
import { _resetSecretStoreForTests, setSecretStore } from '../../shared/secure-storage/secret-store'
import { useBotToolCredentialsRoot } from './bot-tool-credentials'
import { setBotToolVaultCredential } from './bot-tool-vault-grant'
import { botToolsPath, readBotToolsSnapshot, writeBotToolServers } from './bot-tools-file'
import { botToolCredentialSource } from './tool-oauth/bot-tool-credential-source'

it('resolves a linked key on each Bot tool request and never sends it to a changed URL', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-bot-vault-test-'))
  const folder = join(root, 'bot')
  const key = Buffer.alloc(32, 8)
  const url = 'https://mcp.example.test/tool'
  try {
    useBotToolCredentialsRoot(join(root, 'credentials'))
    setSecretStore({
      isEncryptionAvailable: () => true,
      encryptString: (value) => sealOrcadSecret(key, value),
      decryptString: (cipher) => openOrcadSecret(key, cipher),
      describeProtectionGap: () => 'test host key',
      describeSealing: () => ({ kind: 'host-key', warning: 'test host key' })
    })
    const server = configureServerCredentialVault(root)
    const draft = { kind: 'secret', name: 'Test key', username: '', website: '', value: 'key-one' }
    const saved = await server.vault.save(draft)
    if (!saved.ok) {
      throw new Error('Could not save the fixture credential')
    }
    const id = saved.value[0].id
    await writeBotToolServers(folder, [{ name: 'test-tool', url }])
    const { version } = await readBotToolsSnapshot(folder)
    await setBotToolVaultCredential(folder, server, {
      botId: 'test-bot',
      name: 'test-tool',
      url,
      version,
      binding: { id, scheme: 'bearer' }
    })
    const {
      servers: [tool]
    } = await readBotToolsSnapshot(folder)
    if (!tool || !('url' in tool) || !tool.credential) {
      throw new Error('Tool was not linked')
    }
    const source = botToolCredentialSource()
    const readForTool = () =>
      source({
        host: 'local',
        folder,
        credentialId: tool.credential ?? '',
        signal: new AbortController().signal
      })
    expect(await readForTool()).toMatchObject({
      kind: 'ready',
      url,
      headers: { authorization: 'Bearer key-one' }
    })
    expect((await server.vault.save({ ...draft, id, value: 'key-two' })).ok).toBe(true)
    expect(await readForTool()).toMatchObject({
      kind: 'ready',
      url,
      headers: { authorization: 'Bearer key-two' }
    })
    writeFileSync(
      botToolsPath(folder),
      JSON.stringify({ servers: [{ ...tool, url: 'https://mcp.example.test/other' }] })
    )
    expect(await readForTool()).toEqual({ kind: 'missing' })
    writeFileSync(botToolsPath(folder), JSON.stringify({ servers: [tool] }))
    expect((await server.vault.remove(id)).ok).toBe(true)
    expect(await readForTool()).toEqual({ kind: 'unavailable' })
  } finally {
    useBotToolCredentialsRoot(null)
    _resetSecretStoreForTests()
    rmSync(root, { recursive: true, force: true })
  }
})
