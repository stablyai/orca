import type { CliInstallState, CliInstallStatus } from '../../shared/cli-install-types'
import { listRunningWslDistrosAsync, listWslDistrosAsync } from '../wsl'
import { CliInstaller } from './cli-installer'
import {
  getWslCliRegistrationCandidateEntries,
  recordWslCliRegistrationObservations,
  type WslCliRegistrationCandidate,
  type WslCliRegistrationObservation
} from './wsl-cli-registration-registry'
import { WslCliInstaller, WslCliOwnershipProbeError } from './wsl-cli-installer'
import {
  normalizeWslDistroKey,
  runSerializedWslCliRegistrationOperation
} from './wsl-cli-registration-operation'

// Why: candidate distros can each boot a stopped WSL VM; a small cap staggers
// those boots instead of spiking RAM/CPU for every distro at once at startup.
const MAX_CONCURRENT_DISTRO_REPAIRS = 2

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
  ) => Promise<WslCliRegistrationCandidate[]>
  recordObservations: (observations: WslCliRegistrationObservation[]) => Promise<void>
}

type WslCliRegistrationReconciliationOptions = {
  platform?: NodeJS.Platform
  isPackaged: boolean
  userDataPath: string
  appVersion?: string
  listDistros?: () => Promise<string[]>
  listRunningDistros?: () => Promise<string[]>
  createInstaller?: (distro: string) => ManagedWslCliInstaller
  getHostLauncherTarget?: () => Promise<string | null>
  registry?: WslCliRegistrationRegistry
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
        getWslCliRegistrationCandidateEntries(
          options.userDataPath,
          availableDistros,
          context ?? {}
        ),
      recordObservations: (observations) =>
        recordWslCliRegistrationObservations(options.userDataPath, observations)
    } satisfies WslCliRegistrationRegistry)

  let createInstaller = options.createInstaller
  let getHostLauncherTarget = options.getHostLauncherTarget
  if (!createInstaller) {
    const hostInstaller = new CliInstaller()
    let hostStatus: Promise<CliInstallStatus> | null = null
    // Why: every distro must target this app install; share one Windows PATH /
    // launcher probe instead of spawning a PowerShell probe per distro. A
    // rejected probe is evicted so one transient failure cannot poison the run.
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
  // Why: discovery is speculative, so it must never boot a stopped VM (`--list --running`
  // does not, and a stale fallback list is refused); only distros the user registered
  // justify `wsl -d` against a stopped VM. Without a host launcher target a failed probe
  // cannot be blamed on the distro, so discovery waits for a launch where the host works.
  const listRunning =
    options.listRunningDistros ?? (() => listRunningWslDistrosAsync({ requireConfirmed: true }))
  const running =
    currentTarget && candidates.some((candidate) => !candidate.registered)
      ? new Set((await listRunning().catch(() => [])).map(normalizeWslDistroKey))
      : null
  const discovery = new Set<string>()
  const distros = candidates.flatMap(({ distro, registered }) => {
    if (registered) {
      return [distro]
    }
    if (!running?.has(normalizeWslDistroKey(distro))) {
      return []
    }
    discovery.add(distro)
    return [distro]
  })
  if (distros.length === 0) {
    return []
  }

  const reconcileDistro = async (
    distro: string
  ): Promise<WslCliRegistrationReconciliationResult> => {
    let repair: Awaited<ReturnType<ManagedWslCliInstaller['repairManagedRegistration']>>
    try {
      repair = await createInstaller(distro).repairManagedRegistration()
    } catch (error) {
      if (discovery.has(distro) && error instanceof WslCliOwnershipProbeError) {
        // Why: an unrecorded guest failure (e.g. a cold-distro timeout) re-probed this
        // never-registered distro on every launch. Failures after ownership is known
        // (a stale Orca wrapper whose install failed) must retry next launch instead.
        await registry
          .recordObservations([{ distro, inspected: true, managed: null }])
          .catch(() => undefined)
      }
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
        ? // Why: managed-ness is unknowable without interop; stamp the
          // inspection (negative TTL) without changing registration ownership.
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
      // Why: ownership metadata must commit before a concurrent Settings
      // operation can mutate this distro, or stale startup state can win.
      await registry.recordObservations([observation])
    } catch (error) {
      // Why: the repair already succeeded on disk; an advisory bookkeeping
      // failure must not reclassify it, mirroring the Settings IPC contract.
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
        results[index] = await runSerializedWslCliRegistrationOperation(distro, () =>
          reconcileDistro(distro)
        )
      }
    })
  )
  return results
}
