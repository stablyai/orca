import { registerLazyIpcHandleGroup } from '../lazy-ipc-handle-group'
import type { RateLimitService } from '../../rate-limits/service/rate-limit-service'

const DIAGNOSTICS_CHANNELS = [
  'diagnostics:getStatus',
  'diagnostics:collectBundle',
  'diagnostics:uploadBundle',
  'diagnostics:openBundlePreview',
  'diagnostics:discardBundlePreview',
  'diagnostics:deleteBundle'
] as const

const DEVELOPER_PERMISSION_CHANNELS = [
  'developerPermissions:getStatus',
  'developerPermissions:request',
  'developerPermissions:openSettings',
  'developerPermissions:testLocalNetworkConnection'
] as const

const COMPUTER_USE_PERMISSION_CHANNELS = [
  'computerUsePermissions:openSetup',
  'computerUsePermissions:getStatus',
  'computerUsePermissions:reset'
] as const

const OPENCODE_GO_CREDENTIALS_CHANNELS = [
  'opencodeGoCredentials:getStatus',
  'opencodeGoCredentials:saveApiKey',
  'opencodeGoCredentials:clearApiKey'
] as const

const MINIMAX_CREDENTIALS_CHANNELS = [
  'minimaxCredentials:getStatus',
  'minimaxCredentials:saveCookie',
  'minimaxCredentials:clearCookie',
  'minimaxCredentials:saveApiKey',
  'minimaxCredentials:clearApiKey'
] as const

const ZCODE_PLAN_CREDENTIALS_CHANNELS = [
  'zcodePlanCredentials:getStatus',
  'zcodePlanCredentials:saveApiKey',
  'zcodePlanCredentials:clearApiKey'
] as const

const GROK_ACCOUNT_CHANNELS = ['grokAccounts:getStatus'] as const

const CURSOR_ACCOUNT_CHANNELS = ['cursorAccounts:getStatus'] as const

export function registerLazyAccountAndDiagnosticIpcHandlers(rateLimits: RateLimitService): void {
  registerLazyIpcHandleGroup(DIAGNOSTICS_CHANNELS, async (ipc) => {
    const { registerDiagnosticsHandlers } = await import('../diagnostics')
    registerDiagnosticsHandlers(ipc)
  })

  registerLazyIpcHandleGroup(DEVELOPER_PERMISSION_CHANNELS, async (ipc) => {
    const { registerDeveloperPermissionHandlers } =
      await import('../developer-permissions/developer-permissions')
    registerDeveloperPermissionHandlers(ipc)
  })

  registerLazyIpcHandleGroup(COMPUTER_USE_PERMISSION_CHANNELS, async (ipc) => {
    const { registerComputerUsePermissionHandlers } = await import('../computer-use-permissions')
    registerComputerUsePermissionHandlers(ipc)
  })

  registerLazyIpcHandleGroup(OPENCODE_GO_CREDENTIALS_CHANNELS, async (ipc) => {
    const { registerOpenCodeGoCredentialsHandlers } =
      await import('../accounts/opencode-go-credentials')
    registerOpenCodeGoCredentialsHandlers(rateLimits, ipc)
  })

  registerLazyIpcHandleGroup(MINIMAX_CREDENTIALS_CHANNELS, async (ipc) => {
    const { registerMiniMaxCredentialsHandlers } = await import('../accounts/minimax-credentials')
    registerMiniMaxCredentialsHandlers(rateLimits, ipc)
  })

  registerLazyIpcHandleGroup(ZCODE_PLAN_CREDENTIALS_CHANNELS, async (ipc) => {
    const { registerZcodePlanCredentialsHandlers } =
      await import('../accounts/zcode-plan-credentials')
    registerZcodePlanCredentialsHandlers(rateLimits, ipc)
  })

  registerLazyIpcHandleGroup(GROK_ACCOUNT_CHANNELS, async (ipc) => {
    const { registerGrokAccountHandlers } = await import('../accounts/grok-accounts')
    registerGrokAccountHandlers(ipc)
  })

  registerLazyIpcHandleGroup(CURSOR_ACCOUNT_CHANNELS, async (ipc) => {
    const { registerCursorAccountHandlers } = await import('../accounts/cursor-accounts')
    registerCursorAccountHandlers(ipc)
  })
}
