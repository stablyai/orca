import type { Store } from '../../../persistence/loading-store/store'
import type { createProviderAccountServices } from '../../../providers/accounts/provider-account-services'
import { createCodexSessionMigrationScheduler } from './codex-session-migration-scheduler'
import { resolveHostCodexSessionSourceHome } from '../rollouts/codex-session-source-home'
import {
  getCodexPaneAccount,
  isCodexPaneHomeRouteProvenAwayFromSharedHome
} from '../../configuration/homes/codex-pane-account-registry'
import type { CodexHomePtySpawnedLifecycleArgs } from '../../../ipc/pty/host-env/types'

type CodexRuntimeHome = ReturnType<typeof createProviderAccountServices>['codexRuntimeHome']

export function createDesktopCodexSessionMigration(
  store: Store,
  getRuntimeHome: () => CodexRuntimeHome | null | undefined,
  isQuitting: () => boolean
): ReturnType<typeof createCodexSessionMigrationScheduler> {
  return createCodexSessionMigrationScheduler({
    isEligible: () => getRuntimeHome()?.isHostSystemDefaultSessionMigrationEligible() === true,
    isQuitting,
    resolveSystemCodexHomePathOverride: () =>
      resolveHostCodexSessionSourceHome(store.getSettings()),
    prepareScheduledRun: (fullScanRequired, newFullScanRequest) =>
      getRuntimeHome()?.prepareHostSystemDefaultSessionMigrationPass(
        fullScanRequired,
        newFullScanRequest
      ),
    finishScheduledRun: () => getRuntimeHome()?.finishHostSystemDefaultSessionMigrationPass(),
    startBackfill: async (options, systemCodexHomePathOverride) => {
      const { startCodexSessionBackfillInBackground } = await import('./codex-session-backfill')
      return startCodexSessionBackfillInBackground(options, systemCodexHomePathOverride)
    },
    startIndexHeal: async (options, systemCodexHomePathOverride) => {
      const { startCodexSessionIndexHealInBackground } =
        await import('../index/codex-session-index-heal')
      return startCodexSessionIndexHealInBackground(options, systemCodexHomePathOverride)
    }
  })
}

export function recordCodexMigrationPtySpawn(
  scheduler: ReturnType<typeof createCodexSessionMigrationScheduler> | null | undefined,
  runtimeHome: CodexRuntimeHome | null | undefined,
  args: CodexHomePtySpawnedLifecycleArgs
): void {
  // Only shared/ambiguous retained shells may still produce rollout logs needing publication.
  if (args.reattached && args.startedSequence !== undefined) {
    const paneAccount = getCodexPaneAccount(args.id)
    const homeRoute =
      args.reattachedHomeRoute !== undefined
        ? (args.reattachedHomeRoute ?? undefined)
        : paneAccount?.homeRoute
    if (scheduler && isCodexPaneHomeRouteProvenAwayFromSharedHome(homeRoute)) {
      scheduler.ignoreLaunch(args.id, args.startedSequence)
      return
    }
  }
  const fullScanRequired =
    runtimeHome?.beginHostSystemDefaultSessionMigrationLaunch(args.codexHomePath, {
      reattached: args.reattached,
      launchEnv: args.launchEnv
    }) ?? null
  if (fullScanRequired !== null) {
    scheduler?.beginLaunch(
      args.id,
      args.reattached === true || fullScanRequired,
      args.startedAt,
      args.startedSequence
    )
  }
}
