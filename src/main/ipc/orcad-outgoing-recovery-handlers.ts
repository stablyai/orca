import { ipcMain } from 'electron'
import { registerOrcadLiveMigrationHandlers } from './orcad-live-migration-handlers'
import type { OrcadLiveMigrationContext } from '../ssh/orcad-live-migration-selection'
import { z } from 'zod'
import { parsePtyOwnershipTransferSurfaceBinding } from '../../shared/pty-ownership-transfer-surface-binding'
import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
import { isPtyOwnershipTransferMutationEnabled } from '../../shared/pty-ownership-transfer-release-gate'
import { prepareOutgoingOrcadTerminalFromProvider } from '../ssh/orcad-outgoing-terminal-preparation'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import {
  listOutgoingOrcadRecoveryCandidates,
  recoverSelectedOutgoingOrcadCapture,
  type OrcadOutgoingRecoveryRuntime
} from '../ssh/orcad-outgoing-recovery-selection'

const selection = z.object({ selector: z.string().trim().min(1).max(1024) })
const listing = selection.extend({ includePreparations: z.boolean().optional() })
const recovery = selection.extend({
  bridgeId: z.string().min(1).max(1024),
  stage: z.enum(['capture', 'preparation']).optional()
})
const preparation = selection
  .extend({
    ptyId: z.string().min(1).max(4096),
    surfaceBinding: z.unknown().transform(parsePtyOwnershipTransferSurfaceBinding)
  })
  .refine(
    (args) => {
      const route = parseAppSshPtyId(args.ptyId)
      return (
        route &&
        args.surfaceBinding.executionHostId === 'local' &&
        args.surfaceBinding.ptyId === route.relayPtyId
      )
    },
    { message: 'orcad_outgoing_capture_source_route_invalid' }
  )

export function registerOrcadOutgoingRecoveryHandlers(
  getUserDataPath: () => string,
  runtime?: OrcadOutgoingRecoveryRuntime &
    Partial<Pick<OrcaRuntimeService, 'bindOutgoingSshPtySurface'>>,
  liveMigrationContext?: OrcadLiveMigrationContext
): void {
  registerOrcadLiveMigrationHandlers(getUserDataPath, liveMigrationContext)
  ipcMain.handle('runtimeEnvironments:listOrcadOutgoingCaptures', (_event, value: unknown) => {
    const args = listing.parse(value)
    return listOutgoingOrcadRecoveryCandidates(
      getUserDataPath(),
      args.selector,
      args.includePreparations
    )
  })
  for (const operation of ['recover', 'prepare'] as const) {
    ipcMain.handle(
      operation === 'prepare'
        ? 'runtimeEnvironments:prepareOrcadOutgoingTerminal'
        : 'runtimeEnvironments:recoverOrcadOutgoingCapture',
      async (event, value: unknown) => {
        const args = operation === 'prepare' ? preparation.parse(value) : recovery.parse(value)
        if (operation === 'prepare') {
          if (!isPtyOwnershipTransferMutationEnabled()) {
            throw new Error('pty_ownership_transfer_mutation_disabled')
          }
          if (!runtime?.bindOutgoingSshPtySurface) {
            throw new Error('orcad_outgoing_preparation_runtime_unavailable')
          }
        }
        const controller = new AbortController()
        const cancel = () => controller.abort(new Error('orcad_outgoing_recovery_caller_destroyed'))
        event.sender.once('destroyed', cancel)
        try {
          if (event.sender.isDestroyed()) {
            cancel()
          }
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)])
          signal.throwIfAborted()
          if ('ptyId' in args) {
            const assertSurface = runtime!.bindOutgoingSshPtySurface!(
              args.ptyId,
              args.surfaceBinding
            )
            const result = await prepareOutgoingOrcadTerminalFromProvider(getUserDataPath(), {
              ...args,
              runtime: runtime!,
              signal,
              assertSurface
            })
            return { bridgeId: result.identity.bridgeId, outcome: result.outcome }
          }
          return await recoverSelectedOutgoingOrcadCapture(getUserDataPath(), {
            ...args,
            ...(args.stage === 'preparation' ? { runtime } : {}),
            signal
          })
        } finally {
          event.sender.removeListener('destroyed', cancel)
        }
      }
    )
  }
}
