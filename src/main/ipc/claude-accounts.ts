import { ipcMain } from 'electron'
import type { AddClaudeAccountInput } from '../../shared/types'
import type { ClaudeAccountService } from '../claude-accounts/service'
import {
  clearPresetRegistryCache,
  fetchPresetRegistry,
  type PresetRegistry
} from '../claude-accounts/preset-registry'

// Why: T18 — dedicated probe payloads for Bedrock + Vertex. The renderer ships
// the smallest viable shape (region/secret for Bedrock, projectId/region for
// Vertex) and the IPC handler reconstructs the discriminated AddClaudeAccountInput
// before delegating to `service.validateInput`. Keeps the renderer free of
// auth-method-construction logic.
type BedrockDetectPayload = {
  region: string
  secret: string
  inferenceProfilePrefix?: string
}
type VertexDetectPayload = {
  projectId: string
  region: string
}

function buildBedrockProbeInput(payload: BedrockDetectPayload): AddClaudeAccountInput {
  const providerConfig: { region: string; inferenceProfilePrefix?: string } = {
    region: payload.region
  }
  if (payload.inferenceProfilePrefix) {
    providerConfig.inferenceProfilePrefix = payload.inferenceProfilePrefix
  }
  // IAM-chain path: omit secretFromUser entirely so service.buildCredentialsFromInput
  // sees the same discriminator shape the renderer form emits.
  if (payload.secret) {
    return {
      authMethod: 'aws-bedrock',
      secretFromUser: payload.secret,
      providerConfig
    }
  }
  return {
    authMethod: 'aws-bedrock',
    providerConfig
  }
}

function buildVertexProbeInput(payload: VertexDetectPayload): AddClaudeAccountInput {
  return {
    authMethod: 'google-vertex',
    providerConfig: { projectId: payload.projectId, region: payload.region }
  }
}

/** Result returned by `claudeAccounts:refresh-preset-defaults`. The renderer
 *  uses `fetchedAt` to render the "Defaults updated Nd ago" timestamp in the
 *  ModelMappingEditor — see T19. */
export type RefreshPresetDefaultsResult = {
  registry: PresetRegistry | null
  fetchedAt: number | null
}

export function registerClaudeAccountHandlers(claudeAccounts: ClaudeAccountService): void {
  ipcMain.handle('claudeAccounts:list', () => claudeAccounts.listAccounts())
  // Why: polymorphic input lets new providers (anthropic-api-key, anthropic-compat)
  // reach service.addAccount; undefined preserves the legacy OAuth no-arg path.
  // The `as never` cast bridges the overloaded signature — runtime validation
  // happens in service.doAddAccountPolymorphic via the discriminator.
  ipcMain.handle('claudeAccounts:add', (_event, input?: AddClaudeAccountInput) =>
    claudeAccounts.addAccount(input as never)
  )
  ipcMain.handle('claudeAccounts:reauthenticate', (_event, args: { accountId: string }) =>
    claudeAccounts.reauthenticateAccount(args.accountId)
  )
  ipcMain.handle('claudeAccounts:remove', (_event, args: { accountId: string }) =>
    claudeAccounts.removeAccount(args.accountId)
  )
  ipcMain.handle('claudeAccounts:select', (_event, args: { accountId: string | null }) =>
    claudeAccounts.selectAccount(args.accountId)
  )
  // Why: read-only live probe — translates HTTP status from the provider's
  // /v1/models endpoint into the locked validation strings consumed by the
  // renderer pill. Errors from the underlying handler are turned into a
  // typed ValidationResult so the renderer never sees raw fetch exceptions.
  ipcMain.handle('claudeAccounts:validate', async (_event, args: { accountId: string }) => {
    try {
      return await claudeAccounts.validateAccount(args.accountId)
    } catch {
      return { ok: false, reason: 'Account not found.' }
    }
  })
  // Why: P2 — workspace override is a pointer-only write into the persistence
  // settings. PTY launch consults the resolver before falling back to the
  // global active account. (#2314)
  ipcMain.handle(
    'claudeAccounts:setWorkspaceOverride',
    (_event, args: { worktreeId: string; accountId: string }) =>
      claudeAccounts.setWorkspaceOverride(args)
  )
  ipcMain.handle(
    'claudeAccounts:clearWorkspaceOverride',
    (_event, args: { worktreeId: string }) => claudeAccounts.clearWorkspaceOverride(args)
  )
  // Why: P2 — Detect/Validate probe for AddAccountModal. Validates a
  // candidate input without persisting the account. Errors are converted to
  // a typed ValidationResult so the renderer never sees raw exceptions.
  ipcMain.handle('claudeAccounts:validateInput', async (_event, input: AddClaudeAccountInput) => {
    try {
      return await claudeAccounts.validateInput(input)
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : 'Validation failed.'
      }
    }
  })
  // Why: P3 T18 — dedicated Detect probes for Bedrock + Vertex. They live on
  // their own channels (rather than reusing `validateInput`) so the renderer
  // forms can call them with the smallest viable payload shape and so the
  // surface is greppable from telemetry / hooks.
  ipcMain.handle(
    'claudeAccounts:bedrock-detect',
    async (_event, payload: BedrockDetectPayload) => {
      try {
        return await claudeAccounts.validateInput(buildBedrockProbeInput(payload))
      } catch (error) {
        return {
          ok: false,
          reason: error instanceof Error ? error.message : 'Bedrock detection failed.'
        }
      }
    }
  )
  ipcMain.handle(
    'claudeAccounts:vertex-detect',
    async (_event, payload: VertexDetectPayload) => {
      try {
        return await claudeAccounts.validateInput(buildVertexProbeInput(payload))
      } catch (error) {
        return {
          ok: false,
          reason: error instanceof Error ? error.message : 'Vertex detection failed.'
        }
      }
    }
  )
  // Why: P3 T18 — bypass the 24h TTL when the user explicitly clicks
  // "Refresh defaults" in ModelMappingEditor. Order is load-bearing: clear
  // first so the subsequent fetch is forced to round-trip the network.
  ipcMain.handle('claudeAccounts:refresh-preset-defaults', async (): Promise<
    RefreshPresetDefaultsResult
  > => {
    await clearPresetRegistryCache()
    const registry = await fetchPresetRegistry()
    return {
      registry,
      fetchedAt: registry ? Date.now() : null
    }
  })
}
