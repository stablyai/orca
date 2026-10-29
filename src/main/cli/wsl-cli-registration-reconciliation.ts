import type { CliInstallState, CliInstallStatus } from '../../shared/cli-install-types'
import { listWslDistrosAsync } from '../wsl'
import {
  deferUntilWslDistroRunning,
  isWslDistroRunning,
  listConfirmedRunningWslDistros
} from '../wsl-background-distro-gate'
import { CliInstaller } from './cli-installer'
import {
  getWslCliRegistrationCandidates,
  recordWslCliRegistrationObservations,
  type WslCliRegistrationObservation
} from './wsl-cli-registration-registry'
import { WslCliInstaller } from './wsl-cli-installer'
import { runSerializedWslCliRegistrationOperation } from './wsl-cli-registration-operation'

// Why: each repair spawns a guest shell; a small cap bounds the startup fan-out.
const MAX_CONCURRENT_DISTRO_REPAIRS = 2
const DEFERRED_RECONCILIATION_KEY = 'wsl-cli-registration-reconciliation'

type ManagedWslCliInstaller = {
  repairManagedRegistration: () => Promise<{
    changed: boolean
    managed: boolean
    status: { state: CliInstallState }
  }>
}

type WslCliRegistrationCandidateContext = {
  currentTarget?: string | null
  appVersion?: string | null
}

type WslCliRegistrationRegistry = {
  getCandidates: (
    availableDistros: string[],
    context?: WslCliRegistrationCandidateContext
  ) => Promise<string[]>
  recordObservations: (observations: WslCliRegistrationObservation[]) => Promise<void>
}

type WslCliRegistrationReconciliationOptions = {
  platform?: NodeJS.Platform
  isPackaged: boolean
  userDataPath: string
  appVersion?: string
  listDistros?: () => Promise<string[]>
  createInstaller?: (distro: string) => ManagedWslCliInstaller
  getHostLauncherTarget?: () => Promise<string | null>
  registry?: WslCliRegistrationRegistry
  listRunningDistros?: () => Promise<string[]>
  /** Settled read taken right before each repair spawns. */
  isDistroRunning?: (distro: string) => Promise<boolean>
  deferUntilRunning?: (distro: string, key: string, task: () => unknown) => void
}

export type WslCliRegistrationReconciliationResult =
  | {
      distro: string
      outcome: 'repaired' | 'unchanged'
      state: CliInstallState
      managed: boolean
    }
  | {
      distro: string
      outcome: 'failed'
      error: string
    }
  | {
      distro: string
      outcome: 'deferred'
    }

export async function reconcileManagedWslCliRegistrations(
  options: WslCliRegistrationReconciliationOptions
): Promise<WslCliRegistrationReconciliationResult[]> {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32' || !options.isPackaged) {
    return []
  }

  const registry =
    options.registry ??
    ({
      getCandidates: (availableDistros, context) =>
        getWslCliRegistrationCandidates(options.userDataPath, availableDistros, context ?? {}),
      recordObservations: (observations) =>
        recordWslCliRegistrationObservations(options.userDataPath, observations)
    } satisfies WslCliRegistrationRegistry)

  let createInstaller = options.createInstaller
  let getHostLauncherTarget = options.getHostLauncherTarget
  if (!createInstaller) {
    const hostInstaller = new CliInstaller()
    let hostStatus: Promise<CliInstallStatus> | null = null
    // Share this install's host probe across distros; evict failures so later repairs can retry.
    const getHostStatus = (): Promise<CliInstallStatus> =>
      (hostStatus ??= hostInstaller.getStatus().catch((error) => {
        hostStatus = null
        throw error
      }))
    createInstaller = (distro: string) =>
      new WslCliInstaller({
        distro,
        hostInstaller: { getStatus: getHostStatus }
      })
    getHostLauncherTarget ??= () => getHostStatus().then((status) => status.launcherPath)
  }

  const availableDistros = await (options.listDistros ?? listWslDistrosAsync)()
  const currentTarget = getHostLauncherTarget
    ? await getHostLauncherTarget().catch(() => null)
    : null
  const appVersion = options.appVersion ?? ''
  const candidates = await registry.getCandidates(availableDistros, { currentTarget, appVersion })
  if (candidates.length === 0) {
    return []
  }
  // Never boot stopped distros for background repair; defer until they run.
  const running = new Set(
    (await (options.listRunningDistros ?? listConfirmedRunningWslDistros)()).map((distro) =>
      distro.toLowerCase()
    )
  )
  const distros = candidates.filter((distro) => running.has(distro.toLowerCase()))
  const deferUntilRunning = options.deferUntilRunning ?? deferUntilWslDistroRunning
  const isDistroRunning = options.isDistroRunning ?? isWslDistroRunning
  const deferReconciliation = (distro: string): WslCliRegistrationReconciliationResult => {
    deferUntilRunning(distro, DEFERRED_RECONCILIATION_KEY, () =>
      reconcileManagedWslCliRegistrations({ ...options, listDistros: async () => [distro] }).then(
        logWslCliReconciliationResults
      )
    )
    return { distro, outcome: 'deferred' }
  }
  const deferred = candidates
    .filter((distro) => !running.has(distro.toLowerCase()))
    .map(deferReconciliation)
  if (distros.length === 0) {
    return deferred
  }

  const reconcileDistro = async (
    distro: string
  ): Promise<WslCliRegistrationReconciliationResult> => {
    let repair: Awaited<ReturnType<ManagedWslCliInstaller['repairManagedRegistration']>>
    try {
      repair = await createInstaller(distro).repairManagedRegistration()
    } catch (error) {
      return {
        distro,
        outcome: 'failed',
        error: error instanceof Error ? error.message : String(error)
      }
    }
    const result: WslCliRegistrationReconciliationResult = {
      distro,
      outcome: repair.changed ? 'repaired' : 'unchanged',
      state: repair.status.state,
      managed: repair.managed
    }
    const observation: WslCliRegistrationObservation =
      repair.status.state === 'unsupported'
        ? // Without interop, record the inspection TTL but preserve unknown ownership.
          { distro, inspected: true, managed: null, reconciled: null }
        : repair.managed
          ? {
              distro,
              inspected: true,
              managed: true,
              ...(currentTarget ? { reconciled: { target: currentTarget, appVersion } } : {})
            }
          : { distro, inspected: true, managed: false, reconciled: null }
    try {
      // Commit ownership while holding the distro queue so Settings cannot race stale startup state.
      await registry.recordObservations([observation])
    } catch (error) {
      // Advisory bookkeeping failure must not reclassify a completed on-disk repair.
      console.warn(
        `[wsl-cli] Failed to record ${distro} registration observation:`,
        error instanceof Error ? error.message : String(error)
      )
    }
    return result
  }

  const results: WslCliRegistrationReconciliationResult[] = Array.from({
    length: distros.length
  })
  let nextIndex = 0
  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT_DISTRO_REPAIRS, distros.length) }, async () => {
      for (;;) {
        const index = nextIndex++
        if (index >= distros.length) {
          return
        }
        const distro = distros[index]
        // The list may name a distro still stopping, or one that stopped while earlier repairs ran (E9).
        results[index] = await runSerializedWslCliRegistrationOperation(distro, async () =>
          (await isDistroRunning(distro)) ? reconcileDistro(distro) : deferReconciliation(distro)
        )
      }
    })
  )
  return [...results, ...deferred]
}

export function logWslCliReconciliationResults(
  results: readonly WslCliRegistrationReconciliationResult[]
): void {
  for (const result of results) {
    if (result.outcome === 'failed') {
      console.warn(
        `[wsl-cli] ${result.distro} managed registration reconciliation failed: ${result.error}`
      )
    } else if (result.outcome === 'repaired') {
      console.log(`[wsl-cli] Repaired managed registration in ${result.distro}.`)
    }
  }
}
