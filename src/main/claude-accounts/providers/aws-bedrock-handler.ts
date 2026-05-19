import { writeManagedClaudeKeychainCredentials } from '../keychain'
import { deriveInferenceProfilePrefix } from './inference-profile'
import type { ProviderHandler } from './types'

type BedrockProviderConfig = {
  region?: string
  inferenceProfilePrefix?: string
}

export function createAwsBedrockHandler(): ProviderHandler {
  return {
    authMethod: 'aws-bedrock',
    registerAccount: async (input) => {
      const cfg = (input.providerConfig as BedrockProviderConfig | undefined) ?? {}
      const region = cfg.region?.trim()
      if (!region) {
        throw new Error('AWS region is required for Bedrock.')
      }

      // Static-token path: bearer token provided → store in keychain.
      // IAM-chain path: empty secret → caller's AWS env (SSO/role) supplies creds at runtime.
      const bearer = input.secretFromUser ?? ''
      if (bearer.length > 0) {
        await writeManagedClaudeKeychainCredentials(input.accountId, bearer)
      }

      // Prefix derives from region unless the user pinned an explicit override.
      const inferenceProfilePrefix =
        cfg.inferenceProfilePrefix ?? deriveInferenceProfilePrefix(region)

      return {
        accountId: input.accountId,
        email: input.label?.trim() || `Bedrock (${region})`,
        credentials: {
          authMethod: 'aws-bedrock',
          region,
          inferenceProfilePrefix
        },
        organizationUuid: null,
        organizationName: null
      }
    },
    materialize: async () => {
      throw new Error('aws-bedrock materialize not implemented yet (P3 Task 4)')
    },
    validate: async () => {
      throw new Error('aws-bedrock validate not implemented yet (P3 Task 5)')
    }
  }
}
