import { ipcMain } from 'electron'
import {
  setSshTargetRegistryHandlers,
  getSshTargetRegistryStore
} from '../../ssh/targets/ssh-target-registry'
import {
  assertSshConnectsNotFenced,
  connectInFlight,
  runSshTestConnectionProbe
} from './ssh-connect-attempt-registry'
import { connectTarget } from './ssh-connect-flow'
import { connectionManager } from './ssh-ipc-context'
import { getPublicSshState } from './ssh-renderer-broadcast'
import { disconnectSshHostForUser } from './ssh-host-user-disconnect'
import { errorMessage } from '../../../shared/error-message'
import {
  clearSshCredentialDeclined,
  isSshCredentialDeclined
} from '../../ssh/ssh-credential-decline'

export function registerSshConnectionHandlers(): void {
  setSshTargetRegistryHandlers({
    connect: connectTarget,
    getState: (targetId: string) => getPublicSshState(targetId)
  })

  ipcMain.handle('ssh:connect', async (_event, args: { targetId: string; automatic?: boolean }) => {
    return connectTarget(args.targetId, { automatic: args.automatic === true })
  })

  ipcMain.handle('ssh:disconnect', async (_event, args: { targetId: string }) => {
    await disconnectSshHostForUser(args.targetId)
  })

  ipcMain.handle('ssh:getState', (_event, args: { targetId: string }) => {
    return getPublicSshState(args.targetId)
  })

  // Auto-connect callers need to avoid prompts when credentials were declined or are no longer cached.
  ipcMain.handle('ssh:needsPassphrasePrompt', (_event, args: { targetId: string }) => {
    if (isSshCredentialDeclined(args.targetId)) {
      return true
    }
    const target = getSshTargetRegistryStore()!.getTarget(args.targetId)
    if (!target?.lastRequiredPassphrase) {
      return false
    }
    return !connectionManager!.hasCachedCredential(target)
  })

  ipcMain.handle('ssh:testConnection', async (_event, args: { targetId: string }) => {
    const target = getSshTargetRegistryStore()!.getTarget(args.targetId)
    if (!target) {
      throw new Error(`SSH target "${args.targetId}" not found`)
    }
    clearSshCredentialDeclined(args.targetId)

    // Probe disconnect would tear down an active connect; join its attempt instead.
    const inFlight = connectInFlight.get(args.targetId)
    if (inFlight) {
      try {
        const state = await inFlight.promise
        return { success: true, state }
      } catch (err) {
        return { success: false, error: errorMessage(err) }
      }
    }

    // Track probe completion so shutdown can join its otherwise sessionless transport.
    const probe = runSshTestConnectionProbe(args.targetId, async () => {
      // Do not open probe transports after the shutdown drain.
      assertSshConnectsNotFenced()
      // Probing a user-disconnected host must leave it disconnected.
      const conn = await connectionManager!.connect(target, { probe: true })
      const state = conn.getState()
      await connectionManager!.disconnect(args.targetId)
      return state
    })
    try {
      return { success: true, state: await probe }
    } catch (err) {
      return { success: false, error: errorMessage(err) }
    }
  })
}
