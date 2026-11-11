import { record } from './structured/launch/claude-structured-model-catalog'

/** A first-party CLI with no credential and no other provider or endpoint is signed out. */
export function claudeCatalogSignedOut(
  initialization: unknown,
  settings: unknown,
  env: Readonly<Record<string, string>>
): boolean {
  const account = record(record(initialization)?.account)
  const effective = record(record(settings)?.effective)
  if (
    !account ||
    !effective ||
    account.tokenSource !== 'none' ||
    (account.apiProvider !== undefined && account.apiProvider !== 'firstParty') ||
    (account.apiKeySource && account.apiKeySource !== 'none') ||
    account.email ||
    account.subscriptionType
  ) {
    return false
  }
  const configuredEnv = record(effective.env)
  const endpoint = configuredEnv?.ANTHROPIC_BASE_URL ?? env.ANTHROPIC_BASE_URL
  if (typeof endpoint === 'string' && endpoint.trim()) {
    try {
      const url = new URL(endpoint)
      return url.protocol === 'https:' && url.hostname === 'api.anthropic.com'
    } catch {
      return false
    }
  }
  return true
}
