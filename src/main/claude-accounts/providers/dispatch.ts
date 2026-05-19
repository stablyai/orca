import type { ClaudeAuthMethod } from '../../../shared/types'
import { createOauthHandler } from './oauth-handler'
import { createAnthropicApiKeyHandler } from './anthropic-api-key-handler'
import { createAnthropicCompatHandler } from './anthropic-compat-handler'
import { createAzureFoundryHandler } from './azure-foundry-handler'
import type { ProviderHandler } from './types'

const HANDLERS: Partial<Record<ClaudeAuthMethod, ProviderHandler>> = {
  'subscription-oauth': createOauthHandler(),
  'anthropic-api-key': createAnthropicApiKeyHandler(),
  'anthropic-compat': createAnthropicCompatHandler(),
  'azure-foundry': createAzureFoundryHandler()
}

export function handlerFor(authMethod: ClaudeAuthMethod): ProviderHandler {
  const handler = HANDLERS[authMethod]
  if (!handler) {
    throw new Error(`No provider handler registered for authMethod ${authMethod}.`)
  }
  return handler
}
