import {
  createClaudeAccount,
  createClaudeCredentialsJson,
  createManagedClaudeAuth,
  createSettings,
  createStore,
  setPlatform,
  testState
} from './runtime-auth-service-test-harness'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const sharedFields = {
  mcpOAuth: { figma: { accessToken: 'mcp-access', refreshToken: 'mcp-refresh' } },
  mcpOAuthClientConfig: { figma: { clientId: 'figma-client' } },
  mcpXaaIdp: { token: 'idp-token' },
  mcpXaaIdpConfig: { issuer: 'idp-issuer' },
  pluginSecrets: { plugin: 'secret' }
}

export function withSharedFields(
  credentials: string,
  fields: Record<string, unknown> = sharedFields
): string {
  return JSON.stringify({ ...JSON.parse(credentials), ...fields })
}

export async function createSharedCredentialRuntime(platform: NodeJS.Platform = 'darwin') {
  setPlatform(platform)
  const runtimePath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
  const system = createClaudeCredentialsJson('system@example.com', 'system')
  const first = createClaudeCredentialsJson('first@example.com', 'first')
  const second = createClaudeCredentialsJson('second@example.com', 'second')
  const firstPath = createManagedClaudeAuth(testState.userDataDir, 'first', first)
  const secondPath = createManagedClaudeAuth(testState.userDataDir, 'second', second)
  writeFileSync(runtimePath, withSharedFields(system))
  testState.scopedKeychainCredentials = withSharedFields(system)
  testState.legacyKeychainCredentials = withSharedFields(system)
  const settings = createSettings({
    claudeManagedAccounts: [
      createClaudeAccount('first', firstPath, { email: 'first@example.com' }),
      createClaudeAccount('second', secondPath, { email: 'second@example.com' })
    ]
  })
  const store = createStore(settings)
  const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Runtime auth uses only getSettings/updateSettings from this store mock.
  const service = new ClaudeRuntimeAuthService(store as never)
  await service.syncForCurrentSelection()
  return { service, settings, runtimePath, first, second, system, firstPath, secondPath }
}
