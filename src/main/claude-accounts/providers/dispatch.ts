import type { ClaudeAuthMethod } from '../../../shared/types'
import { createOauthHandler } from './oauth-handler'
import { createAnthropicApiKeyHandler } from './anthropic-api-key-handler'
import { createAnthropicCompatHandler } from './anthropic-compat-handler'
import { createAzureFoundryHandler } from './azure-foundry-handler'
import { createAwsBedrockHandler } from './aws-bedrock-handler'
import { createGoogleVertexHandler } from './google-vertex-handler'
import type { ProviderHandler } from './types'

const HANDLERS: Partial<Record<ClaudeAuthMethod, ProviderHandler>> = {
  'subscription-oauth': createOauthHandler(),
  'anthropic-api-key': createAnthropicApiKeyHandler(),
  'anthropic-compat': createAnthropicCompatHandler(),
  'azure-foundry': createAzureFoundryHandler(),
  'aws-bedrock': createAwsBedrockHandler(),
  'google-vertex': createGoogleVertexHandler()
}

export function handlerFor(authMethod: ClaudeAuthMethod): ProviderHandler {
  const handler = HANDLERS[authMethod]
  if (!handler) {
    throw new Error(`No provider handler registered for authMethod ${authMethod}.`)
  }
  return handler
}
