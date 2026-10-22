import { ipcMain } from 'electron'
import { z } from 'zod'
import { resolveEnvironment } from '../../../shared/runtime-environment-store'
import { getPreferredPairedRuntimeConnection } from '../../../shared/runtime-environments'
import { normalizeEndpointAuthHeaders } from '../../../shared/network/endpoint-auth-headers'
import {
  clearRuntimeEdgeAuth,
  getRuntimeEdgeAuthStatus,
  writeRuntimeEdgeAuth
} from '../../credentials/runtime-edge-auth-store'

const IdentitySchema = z.object({ environmentId: z.string().min(1).max(1024) })
const MutationSchema = IdentitySchema.extend({
  expectedPairingRevision: z.number().finite().nonnegative()
})
const SaveSchema = MutationSchema.extend({
  headers: z.array(z.object({ name: z.string().max(128), value: z.string().max(1024) })).max(8)
})

type HandlerOptions = {
  getUserDataPath: () => string
  invalidateTransport: (environmentId: string) => Promise<void> | void
}
export function registerRuntimeEnvironmentEdgeAuthHandlers({
  getUserDataPath,
  invalidateTransport
}: HandlerOptions): void {
  ipcMain.handle('runtimeEnvironments:getEdgeAuthStatus', (_event, args: unknown) => {
    const parsed = IdentitySchema.safeParse(args)
    if (!parsed.success) {
      throw new Error('Invalid server selection')
    }
    return getRuntimeEdgeAuthStatus(
      getUserDataPath(),
      resolveEnvironment(getUserDataPath(), parsed.data.environmentId)
    )
  })
  ipcMain.handle('runtimeEnvironments:saveEdgeAuth', async (_event, args: unknown) => {
    const parsed = SaveSchema.safeParse(args)
    if (!parsed.success) {
      throw new Error('Enter valid edge authentication headers')
    }
    const environment = currentEnvironment(getUserDataPath(), parsed.data)
    const normalized = normalizeEndpointAuthHeaders(parsed.data.headers)
    if (!normalized.ok || Object.keys(normalized.headers).length === 0) {
      throw new Error('Enter valid edge authentication headers')
    }
    if (
      !getPreferredPairedRuntimeConnection(environment)
        .endpoint.toLowerCase()
        .startsWith('wss://') ||
      environment.connectionDependency ||
      environment.orcadDeployment ||
      environment.sshAccess
    ) {
      throw new Error('Edge authentication requires a direct secure server address')
    }
    writeRuntimeEdgeAuth(getUserDataPath(), environment, normalized.headers)
    await invalidateTransport(environment.id)
    return getRuntimeEdgeAuthStatus(getUserDataPath(), environment)
  })
  ipcMain.handle('runtimeEnvironments:clearEdgeAuth', async (_event, args: unknown) => {
    const parsed = MutationSchema.safeParse(args)
    if (!parsed.success) {
      throw new Error('Invalid server selection')
    }
    const environment = currentEnvironment(getUserDataPath(), parsed.data)
    clearRuntimeEdgeAuth(getUserDataPath(), environment.id)
    await invalidateTransport(environment.id)
    return getRuntimeEdgeAuthStatus(getUserDataPath(), environment)
  })
}
function currentEnvironment(
  userDataPath: string,
  args: { environmentId: string; expectedPairingRevision: number }
) {
  const environment = resolveEnvironment(userDataPath, args.environmentId)
  if ((environment.pairingRevision ?? environment.createdAt) !== args.expectedPairingRevision) {
    throw new Error('Server pairing changed. Reopen this form and try again.')
  }
  return environment
}
