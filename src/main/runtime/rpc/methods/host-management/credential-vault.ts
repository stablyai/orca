import type { VaultEntry, VaultResult } from '../../../../../shared/secure-storage/credential-vault'
import {
  CREDENTIAL_VAULT_METHOD,
  CredentialVaultOperation
} from '../../../../../shared/rpc-contract/host-management/credential-vault-params'
import { botHomeFolder } from '../../../../bots/bot-home'
import {
  addVaultBackedBotTool,
  setBotToolVaultCredential
} from '../../../../bots/bot-tool-vault-grant'
import { defineMethod } from '../../core'
import { botToolsHome } from '../bots-tools'
import { targetBot } from '../bots-tools-target'

export const CREDENTIAL_VAULT_METHODS = [
  defineMethod({
    name: CREDENTIAL_VAULT_METHOD,
    permission: 'credential-vault',
    params: CredentialVaultOperation,
    handler: async (request, ctx): Promise<VaultResult<VaultEntry[] | string | true>> => {
      if (
        ctx.callerScope?.kind !== 'runtime-paired' ||
        !ctx.callerScope.grants.includes('credential-vault')
      ) {
        return { ok: false, reason: 'forbidden' }
      }
      const server = ctx.credentialVault
      if (!server) {
        return { ok: false, reason: 'unsupported' }
      }
      const { vault } = server
      switch (request.op) {
        case 'list':
          return vault.list()
        case 'save':
          return vault.save(request.draft)
        case 'remove':
          return vault.remove(request.id)
        case 'read':
          return vault.readValue(request.id)
        case 'bot-tool': {
          try {
            const { change } = request
            const bot = targetBot({ botId: change.botId }, ctx)
            await (change.create
              ? addVaultBackedBotTool(await botToolsHome(ctx.runtime, bot), server, change)
              : setBotToolVaultCredential(botHomeFolder(bot), server, change))
            return { ok: true, value: true }
          } catch {
            return { ok: false, reason: 'invalid' }
          }
        }
      }
    }
  })
] as const
