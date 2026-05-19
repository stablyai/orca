import { execFile as _execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  readManagedClaudeKeychainCredentials,
  writeManagedClaudeKeychainCredentials
} from '../keychain'
import { getBedrockDefaults } from '../model-defaults'
import { deriveInferenceProfilePrefix } from './inference-profile'
import type { ProviderHandler } from './types'
import type { ClaudeManagedAccount, ClaudeModelMapping } from '../../../shared/types'

const execFile = promisify(_execFile)

type BedrockProviderConfig = {
  region?: string
  inferenceProfilePrefix?: string
}

function emitModelEnv(account: ClaudeManagedAccount, prefix: string): Record<string, string> {
  // Why: the registry holds unprefixed Bedrock ids. The cross-region
  // inference-profile prefix (e.g. `us.`) is a region-derived band rather
  // than a model identifier, so we concatenate it here at materialize time
  // instead of baking it into the registry value.
  const merged: ClaudeModelMapping = { ...getBedrockDefaults(), ...account.modelMapping }
  const env: Record<string, string> = {}
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
    validate: async (account) => {
      const creds = account.credentials
      if (creds.authMethod !== 'aws-bedrock') {
        return { ok: false, reason: 'AWS Bedrock validate invoked on non-bedrock account.' }
      }
      // No AWS SDK runtime dep — shell out to the user's `aws` CLI. Decision
      // locked in plan: Claude CLI reads AWS_* env directly at launch, so
      // Detect only needs to prove the chain resolves.
      const bearer = await readManagedClaudeKeychainCredentials(account.id)
      try {
        if (!bearer) {
          // IAM-chain path — verify the AWS chain resolves at all.
          await execFile('aws', ['sts', 'get-caller-identity', '--region', creds.region])
          return { ok: true }
        }
        // Static-token path — optionally probe Bedrock model listing so a
        // missing iam:bedrock:* policy surfaces as a locked 403 error here
        // rather than at first prompt.
        await execFile('aws', ['bedrock', 'list-foundation-models', '--region', creds.region])
        return { ok: true }
      } catch (err) {
        const stderr =
          (err as { stderr?: string }).stderr ??
          (err instanceof Error ? err.message : String(err))
        if (/AccessDenied/i.test(stderr)) {
          return {
            ok: false,
            reason: 'Bedrock model access denied. Request in AWS console.',
            rescueHint: 'Request Anthropic model access in the Bedrock model catalog.'
          }
        }
        if (/locate credentials|expired|InvalidToken/i.test(stderr)) {
          return {
            ok: false,
            reason: 'AWS credentials missing/expired. Run `aws sso login` then click Detect.',
            rescueHint: 'Run `aws sso login` (or refresh your role) and retry.'
          }
        }
        return {
          ok: false,
          reason: 'Network or AWS error contacting Bedrock.',
          rescueHint: 'Check your network and the AWS CLI configuration.'
        }
      }
    }
  }
}
