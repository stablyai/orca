import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { getKeyedSerializedQueueTail, runKeyedSerializedOperation } from './keyed-promise-queue'
import { normalizeWslDistroKey } from './wsl-cli-registration-operation'

const REGISTRY_FILE_NAME = 'wsl-cli-registrations.json'
const REGISTRY_SCHEMA_VERSION = 2
const DEFAULT_NEGATIVE_INSPECTION_TTL_MS = 7 * 24 * 60 * 60 * 1_000
// Bound advisory bookkeeping on hosts that cycle through many distro names.
const MAX_INSPECTION_ENTRIES = 64

type WslCliRegistrationReconciliation = {
  target: string
  appVersion: string
}

type WslCliRegistrationRegistryState = {
  schemaVersion: 2
  registeredDistros: string[]
  inspectionTimes: Record<string, number>
  reconciliations: Record<string, WslCliRegistrationReconciliation>
}

type WslCliRegistrationRegistryTiming = {
  now?: number
  negativeInspectionTtlMs?: number
  // Unchanged launcher/build pairs need no repair; app updates must trigger a new probe.
  currentTarget?: string | null
  appVersion?: string | null
  /**
   * Unregistered distros that may still be inspected: ones Orca deployed a host into. Any other
   * distro is the user's own and never gets a guest command (EDR noise, untouched environments).
   */
  inspectableDistros?: readonly string[]
}

export type WslCliRegistrationObservation = {
  distro: string
  inspected: boolean
  // Null preserves ownership when unsupported probes cannot determine whether registration is managed.
  managed: boolean | null
  reconciled?: WslCliRegistrationReconciliation | null
}

const writeQueues = new Map<string, Promise<void>>()

function emptyState(): WslCliRegistrationRegistryState {
  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    registeredDistros: [],
    inspectionTimes: {},
    reconciliations: {}
  }
}

function uniqueDistros(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  const seen = new Set<string>()
  const distros: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry.trim()) {
      continue
    }
    const distro = entry.trim()
    const key = normalizeWslDistroKey(distro)
    if (!seen.has(key)) {
      seen.add(key)
      distros.push(distro)
    }
  }
  return distros
}

function parseReconciliations(value: unknown): Record<string, WslCliRegistrationReconciliation> {
  if (!value || typeof value !== 'object') {
    return {}
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, WslCliRegistrationReconciliation] =>
        !!entry[1] &&
        typeof entry[1] === 'object' &&
        typeof (entry[1] as WslCliRegistrationReconciliation).target === 'string' &&
        typeof (entry[1] as WslCliRegistrationReconciliation).appVersion === 'string'
    )
  )
}

function parseState(content: string): WslCliRegistrationRegistryState {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>
    if (parsed.schemaVersion !== 1 && parsed.schemaVersion !== REGISTRY_SCHEMA_VERSION) {
      return emptyState()
    }
    const inspectionTimes =
      parsed.inspectionTimes && typeof parsed.inspectionTimes === 'object'
        ? Object.fromEntries(
            Object.entries(parsed.inspectionTimes).filter(
              (entry): entry is [string, number] =>
                typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] >= 0
            )
          )
        : {}
    return {
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      registeredDistros: uniqueDistros(parsed.registeredDistros),
      inspectionTimes,
      reconciliations: parseReconciliations(parsed.reconciliations)
    }
  } catch {
    // Rediscover after corruption so managed registrations can still receive updates.
    return emptyState()
  }
}

function isMissingError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

function getRegistryPath(userDataPath: string): string {
  return join(userDataPath, REGISTRY_FILE_NAME)
}

async function readState(userDataPath: string): Promise<WslCliRegistrationRegistryState> {
  try {
    return parseState(await readFile(getRegistryPath(userDataPath), 'utf8'))
  } catch (error) {
    if (isMissingError(error)) {
      return emptyState()
    }
    throw error
  }
}

function upsertDistro(distros: string[], distro: string): string[] {
  const key = normalizeWslDistroKey(distro)
  const existingIndex = distros.findIndex((entry) => normalizeWslDistroKey(entry) === key)
  if (existingIndex === -1) {
    return [...distros, distro.trim()]
  }
  return distros.map((entry, index) => (index === existingIndex ? distro.trim() : entry))
}

function removeDistro(distros: string[], distro: string): string[] {
  const key = normalizeWslDistroKey(distro)
  return distros.filter((entry) => normalizeWslDistroKey(entry) !== key)
}

async function writeState(
  userDataPath: string,
  state: WslCliRegistrationRegistryState
): Promise<void> {
  await mkdir(userDataPath, { recursive: true })
  // writeFileAtomically retries Chromium Protected-DACL EPERM with ACL repair on Windows.
  writeFileAtomically(getRegistryPath(userDataPath), `${JSON.stringify(state, null, 2)}\n`)
}

function capInspectionEntries(
  state: WslCliRegistrationRegistryState
): WslCliRegistrationRegistryState {
  const registered = new Set(state.registeredDistros.map(normalizeWslDistroKey))
  const entries = Object.entries(state.inspectionTimes)
  const inspectionTimes =
    entries.length <= MAX_INSPECTION_ENTRIES
      ? state.inspectionTimes
      : Object.fromEntries(
          entries
            .sort((a, b) => b[1] - a[1])
            .filter((entry, index) => index < MAX_INSPECTION_ENTRIES || registered.has(entry[0]))
        )
  const reconciliations = Object.fromEntries(
    Object.entries(state.reconciliations).filter(([key]) => registered.has(key))
  )
  return { ...state, inspectionTimes, reconciliations }
}

function updateState(
  userDataPath: string,
  update: (state: WslCliRegistrationRegistryState) => WslCliRegistrationRegistryState
): Promise<void> {
  return runKeyedSerializedOperation(writeQueues, getRegistryPath(userDataPath), async () => {
    await writeState(userDataPath, capInspectionEntries(update(await readState(userDataPath))))
  })
}

export async function getWslCliRegistrationCandidates(
  userDataPath: string,
  availableDistros: string[],
  timing: WslCliRegistrationRegistryTiming = {}
): Promise<string[]> {
  // Wait for complete writes; the nonrejecting tail keeps failed writes from aborting discovery.
  await getKeyedSerializedQueueTail(writeQueues, getRegistryPath(userDataPath))
  const state = await readState(userDataPath)
  const registered = new Set(state.registeredDistros.map(normalizeWslDistroKey))
  const now = timing.now ?? Date.now()
  const negativeInspectionTtlMs =
    timing.negativeInspectionTtlMs ?? DEFAULT_NEGATIVE_INSPECTION_TTL_MS
  const inspectable = new Set((timing.inspectableDistros ?? []).map(normalizeWslDistroKey))
  return uniqueDistros(availableDistros).filter((distro) => {
    const key = normalizeWslDistroKey(distro)
    if (registered.has(key)) {
      const reconciliation = state.reconciliations[key]
      return !(
        reconciliation &&
        timing.currentTarget &&
        reconciliation.target === timing.currentTarget &&
        reconciliation.appVersion === (timing.appVersion ?? '')
      )
    }
    if (!inspectable.has(key)) {
      return false
    }
    const inspectedAt = state.inspectionTimes[key]
    return (
      inspectedAt === undefined || inspectedAt > now || now - inspectedAt >= negativeInspectionTtlMs
    )
  })
}

export function recordWslCliRegistrationObservations(
  userDataPath: string,
  observations: WslCliRegistrationObservation[],
  timing: Pick<WslCliRegistrationRegistryTiming, 'now'> = {}
): Promise<void> {
  const effective = observations.filter(
    (observation) => observation.inspected && observation.distro.trim()
  )
  if (effective.length === 0) {
    return Promise.resolve()
  }
  return updateState(userDataPath, (state) => {
    let registeredDistros = state.registeredDistros
    let inspectionTimes = state.inspectionTimes
    let reconciliations = state.reconciliations
    const now = timing.now ?? Date.now()
    for (const observation of effective) {
      const key = normalizeWslDistroKey(observation.distro)
      inspectionTimes = { ...inspectionTimes, [key]: now }
      if (observation.managed === true) {
        registeredDistros = upsertDistro(registeredDistros, observation.distro)
      } else if (observation.managed === false) {
        registeredDistros = removeDistro(registeredDistros, observation.distro)
      }
      if (observation.reconciled !== undefined) {
        if (observation.reconciled === null) {
          const { [key]: _removed, ...rest } = reconciliations
          reconciliations = rest
        } else {
          reconciliations = { ...reconciliations, [key]: observation.reconciled }
        }
      }
    }
    return {
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      registeredDistros,
      inspectionTimes,
      reconciliations
    }
  })
}

export function recordWslCliRegistrationInstalled(
  userDataPath: string,
  distro: string
): Promise<void> {
  return recordWslCliRegistrationObservations(userDataPath, [
    { distro, inspected: true, managed: true }
  ])
}

export function recordWslCliRegistrationRemoved(
  userDataPath: string,
  distro: string
): Promise<void> {
  return recordWslCliRegistrationObservations(userDataPath, [
    { distro, inspected: true, managed: false, reconciled: null }
  ])
}

/** A deleted distro has nothing left to inspect or reconcile, so every entry for it goes. */
export function forgetWslCliRegistration(userDataPath: string, distro: string): Promise<void> {
  const key = normalizeWslDistroKey(distro)
  return updateState(userDataPath, (state) => {
    const { [key]: _inspected, ...inspectionTimes } = state.inspectionTimes
    const { [key]: _reconciled, ...reconciliations } = state.reconciliations
    return {
      ...state,
      registeredDistros: removeDistro(state.registeredDistros, distro),
      inspectionTimes,
      reconciliations
    }
  })
}
