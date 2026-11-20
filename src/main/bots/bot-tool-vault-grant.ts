import type { ServerCredentialVault } from '../credentials/vault/server-credential-vault'
import type {
  BotToolVaultBinding,
  BotToolVaultCreate,
  BotToolVaultEdit
} from '../../shared/secure-storage/credential-vault'
import { newBotToolCredentialId, type BotToolCredential } from './bot-tool-credentials'
import { changeBotToolServers, type BotToolNewCredential } from './bot-tools-file'
import { addBotTool, type BotToolsHome } from './bot-tools-host'
import { botVaultHeader, botVaultSource, isBotVaultSource } from './bot-tool-vault-source'

async function vaultCredential(
  server: ServerCredentialVault,
  url: string,
  { id, scheme }: BotToolVaultBinding
): Promise<BotToolCredential> {
  if (new URL(url).protocol !== 'https:') {
    throw new Error('A vault credential requires an HTTPS tool.')
  }
  const result = await server.vault.readValue(id, 'secret')
  if (!result.ok || !botVaultHeader(scheme, result.value)) {
    throw new Error('The vault entry is no longer usable as an HTTP header.')
  }
  return { url, headers: {}, source: botVaultSource({ scope: server.scope, id, scheme }) }
}

export async function addVaultBackedBotTool(
  home: BotToolsHome,
  server: ServerCredentialVault,
  { name, url, binding }: BotToolVaultCreate
): Promise<void> {
  const saved = await vaultCredential(server, url, binding)
  const credential = newBotToolCredentialId()
  await addBotTool(
    home,
    { name, url, transport: 'http', credential },
    new Map([[credential, saved]])
  )
}

export async function setBotToolVaultCredential(
  folder: string,
  server: ServerCredentialVault,
  change: BotToolVaultEdit
): Promise<void> {
  const credentials = new Map<string, BotToolNewCredential>()
  await changeBotToolServers(
    folder,
    async (tools, savedCredentials) => {
      const tool = tools.find((entry) => entry.name === change.name)
      if (
        !tool ||
        !('url' in tool) ||
        tool.url !== change.url ||
        new URL(tool.url).protocol !== 'https:'
      ) {
        throw new Error('The HTTPS bot tool is no longer available.')
      }
      const saved = tool.credential ? savedCredentials.credential(tool.credential) : null
      if (tool.credential && !isBotVaultSource(saved?.source)) {
        throw new Error('Remove the tool’s existing credentials first.')
      }
      if (change.binding) {
        const credential = tool.credential ?? newBotToolCredentialId()
        credentials.set(credential, await vaultCredential(server, tool.url, change.binding))
        return tools.map((entry) => (entry === tool ? { ...tool, credential } : entry))
      }
      if (!tool.credential) {
        throw new Error('The tool is not linked to the vault.')
      }
      const { credential: _credential, ...unbound } = tool
      return tools.map((entry) => (entry === tool ? unbound : entry))
    },
    change.version,
    undefined,
    credentials
  )
}
