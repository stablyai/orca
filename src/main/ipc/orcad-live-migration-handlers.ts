import { ipcMain } from 'electron'
import { z } from 'zod'
import { startSelectedOrcadLiveMigration } from '../ssh/orcad-live-migration-start'
import {
  getOrcadLiveMigrationRendererPlan,
  orcadLiveMigrationRendererPlanSelectionSchema
} from '../ssh/orcad-live-migration-renderer-plan'
import {
  listSelectedOrcadLiveMigrations,
  resumeSelectedOrcadLiveMigration,
  type OrcadLiveMigrationContext
} from '../ssh/orcad-live-migration-selection'

const listing = z.object({ selector: z.string().trim().min(1).max(1024) })
const resume = listing.extend({
  migrationId: z.string().min(1).max(1024),
  mode: z.enum(['initial', 'recovery'])
})

export function registerOrcadLiveMigrationHandlers(
  getProfileDirectory: () => string,
  context?: OrcadLiveMigrationContext
): void {
  const requireContext = () => {
    if (!context) {
      throw new Error('orcad_live_migration_runtime_unavailable')
    }
    return context
  }
  ipcMain.handle('runtimeEnvironments:listOrcadLiveMigrations', (_event, value: unknown) => {
    const args = listing.parse(value)
    return listSelectedOrcadLiveMigrations(
      getProfileDirectory(),
      requireContext().store,
      args.selector
    )
  })
  ipcMain.handle(
    'runtimeEnvironments:getOrcadLiveMigrationRendererPlan',
    (_event, value: unknown) => {
      const args = orcadLiveMigrationRendererPlanSelectionSchema.parse(value)
      return getOrcadLiveMigrationRendererPlan(getProfileDirectory(), requireContext().store, args)
    }
  )
  function registerMutation<T>(
    channel: string,
    schema: z.ZodType<T>,
    operation: (
      profile: string,
      context: OrcadLiveMigrationContext,
      args: T,
      signal: AbortSignal
    ) => Promise<unknown>
  ) {
    ipcMain.handle(channel, async (event, value: unknown) => {
      const args = schema.parse(value)
      const trusted = requireContext()
      const controller = new AbortController()
      const cancel = () => controller.abort(new Error('orcad_live_migration_caller_destroyed'))
      event.sender.once('destroyed', cancel)
      try {
        if (event.sender.isDestroyed()) {
          cancel()
        }
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)])
        signal.throwIfAborted()
        return await operation(getProfileDirectory(), trusted, args, signal)
      } finally {
        event.sender.removeListener('destroyed', cancel)
      }
    })
  }
  registerMutation(
    'runtimeEnvironments:startOrcadLiveMigration',
    listing.extend({ targetId: z.string().trim().min(1).max(1024) }),
    startSelectedOrcadLiveMigration
  )
  registerMutation(
    'runtimeEnvironments:resumeOrcadLiveMigration',
    resume,
    resumeSelectedOrcadLiveMigration
  )
}
