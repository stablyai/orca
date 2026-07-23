import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  NodeFileReadTooLargeError,
  readNodeFileWithinLimit
} from '../../shared/node-bounded-file-reader'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { getKeyedSerializedQueueTail, runKeyedSerializedOperation } from './keyed-promise-queue'
import { normalizeWslDistroKey } from './wsl-cli-registration-operation'

const REGISTRY_FILE_NAME = 'wsl-cli-registrations.json'
const REGISTRY_SCHEMA_VERSION = 2
const DEFAULT_NEGATIVE_INSPECTION_TTL_MS = 7 * 24 * 60 * 60 * 1_000
export const WSL_CLI_REGISTRY_MAX_BYTES = 1024 * 1024
// Why: the registry is advisory; cap per-distro bookkeeping so hosts that
// cycle many uniquely named distros cannot grow the file without bound.
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
  // Why: a registered distro already reconciled against this exact launcher
  // by this exact app build has nothing to repair; skipping it avoids booting
  // its VM on every startup while still re-probing after each app update.
  currentTarget?: string | null
  appVersion?: string | null
}

export type WslCliRegistrationObservation = {
  distro: string
  inspected: boolean
  // Why: null records an inspection without changing registration ownership —
  // used for 'unsupported' probes where managed-ness could not be determined.
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
    // Why: a corrupt advisory registry must trigger safe rediscovery rather
    // than preventing managed registrations from receiving future updates.
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
    const { buffer } = await readNodeFileWithinLimit(
      getRegistryPath(userDataPath),
      WSL_CLI_REGISTRY_MAX_BYTES
    )
    return parseState(buffer.toString('utf8'))
  } catch (error) {
    if (isMissingError(error)) {
      return emptyState()
    }
    if (error instanceof NodeFileReadTooLargeError) {
      return emptyState()
    }
    throw error
  }
}

function upsertDistro(distros: string[], distro: string): string[] {
  const key = normalizeWslDistroKey(distro)
  const existingIndex = distros.findIndex((entry) => normalizeWslDistroKey(entry) === key)
  if (existingIndex < 0) {
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
  // Why: userData writes on Windows can hit Chromium's Protected-DACL EPERM;
  // writeFileAtomically carries the ACL-repair retry a plain rename lacks.
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
  // Why: the stored queue tail never rejects, so a failed concurrent write
  // cannot abort candidate discovery; reads still see fully applied updates.
  await getKeyedSerializedQueueTail(writeQueues, getRegistryPath(userDataPath))
  const state = await readState(userDataPath)
  const registered = new Set(state.registeredDistros.map(normalizeWslDistroKey))
  const now = timing.now ?? Date.now()
  const negativeInspectionTtlMs =
    timing.negativeInspectionTtlMs ?? DEFAULT_NEGATIVE_INSPECTION_TTL_MS
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
