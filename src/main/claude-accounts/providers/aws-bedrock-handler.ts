import {
  readManagedClaudeKeychainCredentials,
  writeManagedClaudeKeychainCredentials
} from '../keychain'
import { deriveInferenceProfilePrefix } from './inference-profile'
import type { ProviderHandler } from './types'
import type { ClaudeManagedAccount, ClaudeModelMapping } from '../../../shared/types'

type BedrockProviderConfig = {
  region?: string
  inferenceProfilePrefix?: string
}

// Unprefixed Bedrock model ids. Geographic inference-profile prefix
// (e.g. `us.`) is applied at materialize time. The handler intentionally
// keeps this constant local; P3 Task 9 hoists it to `model-defaults.ts`.
const BEDROCK_DEFAULTS: Required<ClaudeModelMapping> = {
  opus: 'anthropic.claude-opus-4-7',
  sonnet: 'anthropic.claude-sonnet-4-6',
  haiku: 'anthropic.claude-haiku-4-5-20251001-v1:0'
}

function emitModelEnv(account: ClaudeManagedAccount, prefix: string): Record<string, string> {
  const merged: ClaudeModelMapping = { ...BEDROCK_DEFAULTS, ...account.modelMapping }
  const env: Record<string, string> = {}
  // Apply prefix to whichever id is in play (default OR override). The prefix
  // is the cross-region inference-profile band, not a model identifier change.
  if (merged.opus) env.ANTHROPIC_DEFAULT_OPUS_MODEL = `${prefix}${merged.opus}`
  if (merged.sonnet) env.ANTHROPIC_DEFAULT_SONNET_MODEL = `${prefix}${merged.sonnet}`
  if (merged.haiku) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = `${prefix}${merged.haiku}`
  return env
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
    materialize: async (account) => {
      const creds = account.credentials
      if (creds.authMethod !== 'aws-bedrock') {
        throw new Error('AWS Bedrock handler invoked on non-bedrock account.')
      }
      const prefix = creds.inferenceProfilePrefix ?? ''
      // Absent bearer → IAM-chain path; the user's AWS env supplies SigV4 creds
      // at launch. Claude CLI reads AWS_REGION + AWS_* env on its own.
      const bearer = await readManagedClaudeKeychainCredentials(account.id)

      const env: Record<string, string> = {
        CLAUDE_CODE_USE_BEDROCK: '1',
        AWS_REGION: creds.region,
        ...emitModelEnv(account, prefix)
      }
      if (bearer) {
        env.AWS_BEARER_TOKEN_BEDROCK = bearer
      }
      return { envPatch: env }
    },
    validate: async () => {
      throw new Error('aws-bedrock validate not implemented yet (P3 Task 5)')
    }
  }
}
