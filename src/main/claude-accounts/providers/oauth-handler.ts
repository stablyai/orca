import type { ProviderHandler } from './types'

export function createOauthHandler(): ProviderHandler {
  return {
    authMethod: 'subscription-oauth',
    registerAccount: async () => {
      throw new Error(
        'OAuth registration uses ClaudeAccountService.doAddAccount directly — not the provider strategy entrypoint.'
      )
    },
    materialize: async (account) => ({
      envPatch: {},
      configDirPath: account.managedAuthPath
    }),
    validate: async () => ({ ok: true })
  }
}
