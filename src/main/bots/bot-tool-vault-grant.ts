import type { ServerCredentialVault } from '../credentials/vault/server-credential-vault'
import type { BotToolVaultChange } from '../../shared/secure-storage/credential-vault'
import { readBotToolCredential, newBotToolCredentialId } from './bot-tool-credentials'
import { changeBotToolServers, type BotToolNewCredential } from './bot-tools-file'
import { botVaultHeader, botVaultSource, isBotVaultSource } from './bot-tool-vault-source'

export async function setBotToolVaultCredential(
  folder: string,
  server: ServerCredentialVault,
  change: BotToolVaultChange
): Promise<void> {
  const credentials = new Map<string, BotToolNewCredential>()
  await changeBotToolServers(
    folder,
    (tools) => {
      const tool = tools.find((entry) => entry.name === change.name)
      if (
        !tool ||
        !('url' in tool) ||
        tool.url !== change.url ||
        new URL(tool.url).protocol !== 'https:'
      ) {
        throw new Error('The HTTPS bot tool is no longer available.')
      }
      const saved = tool.credential ? readBotToolCredential(folder, tool.credential) : null
      if (tool.credential && !isBotVaultSource(saved?.source)) {
        throw new Error('Remove the tool’s existing credentials first.')
      }
      if (change.binding) {
        const { id, scheme } = change.binding
        const result = server.vault.readValue(id, 'secret')
        if (!result.ok || !botVaultHeader(scheme, result.value)) {
          throw new Error('The vault entry is no longer usable as an HTTP header.')
        }
        const credential = tool.credential ?? newBotToolCredentialId()
        credentials.set(credential, {
          url: tool.url,
          headers: {},
          source: botVaultSource({ scope: server.scope, id, scheme })
        })
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
