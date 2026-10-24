import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { getAppEnvironment } from '../../shared/app-environment'
import type { ProviderCleanupBudget } from './provider-process-exit-deadline'
import type { ProviderGroupMember } from './provider-process-group'
import {
  readPosixProcessRow,
  readProviderWriterVerdict,
  pruneProviderMembers
} from './provider-process-row-read'

const member = z.object({
  pid: z.number().int().min(2),
  pgid: z.number().int().min(2),
  startedAt: z.string()
})
const schema = z.object({
  version: z.literal(1),
  origin: z.literal('direct'),
  token: z.string().uuid(),
  directory: z.string(),
  createdAt: z.number(),
  pgid: z.number().int().min(2),
  owner: member,
  members: member.array(),
  resource: z.object({ kind: z.literal('codex-home'), key: z.string() }).optional(),
  groupRetired: z.literal(true).optional(),
  unknownSince: z
    .object({ group: z.number().optional(), resource: z.number().optional() })
    .optional()
})
export type ProviderLedgerEntry = z.infer<typeof schema>
export type ProviderResource = NonNullable<ProviderLedgerEntry['resource']>
export type ProviderResourceResult = 'released' | 'live' | 'unknown'
export type ProviderLaunchRecord = {
  capture(budget?: ProviderCleanupBudget): Promise<void>
  members(): readonly ProviderGroupMember[]
  retire(): Promise<void>
  verifyResource?(budget: ProviderCleanupBudget): Promise<ProviderResourceResult>
  cleanup?(budget: ProviderCleanupBudget, action: () => Promise<void>): Promise<void>
}

export type ProviderLedgerState = {
  entry: ProviderLedgerEntry
  tail: Promise<void>
  local?: boolean
  flight?: Promise<ProviderResourceResult | void>
}
const entries = new Map<string, ProviderLedgerState>()
let namespace: string | undefined
let discovered = false
let discovery: Promise<boolean> | undefined
let mutationOwner = false
let active = 0
const available = new Set<() => void>()

export function setProviderRecoveryMutationOwner(acquired: boolean): void {
  mutationOwner = acquired
}

export function providerLedgerDirectory(): string {
  const directory = join(getAppEnvironment().getPath('userData'), 'provider-processes')
  if (namespace !== directory) {
    namespace = directory
    discovered = false
    discovery = undefined
    entries.clear()
  }
  return directory
}

export function providerLedgerStates(): ProviderLedgerState[] {
  providerLedgerDirectory()
  return [...entries.values()]
}

export function installProviderLedgerEntry(
  entry: ProviderLedgerEntry,
  local = false
): ProviderLedgerState {
  const known = entries.get(entry.token)
  if (known) {
    return known
  }
  const state = { entry, local, tail: Promise.resolve() }
  entries.set(entry.token, state)
  return state
}

export async function readProviderLedgerEntry(
  path: string,
  budget: ProviderCleanupBudget
): Promise<ProviderLedgerEntry | null> {
  const text = await readFile(path, { encoding: 'utf8', signal: budget.signal })
  try {
    const parsed = schema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : null
  } catch {
    return null // Readable malformed metadata is distinct from an unavailable read.
  }
}

export function discoverProviderLaunches(
  budget: ProviderCleanupBudget,
  issued?: (work: Promise<unknown>) => void
): Promise<boolean> {
  if (process.platform === 'win32') {
    return Promise.resolve(true)
  }
  const directory = providerLedgerDirectory()
  if (discovered) {
    return Promise.resolve(true)
  }
  discovery ??= (async () => {
    let complete = true
    try {
      const names = await readdir(directory)
      for (const name of names) {
        if (!budget.active) {
          return false
        }
        if (!/^[\da-f-]+\.json$/.test(name)) {
          continue
        }
        try {
          const entry = await readProviderLedgerEntry(join(directory, name), budget)
          if (
            budget.active &&
            namespace === directory &&
            entry?.directory === directory &&
            `${entry.token}.json` === name
          ) {
            installProviderLedgerEntry(entry)
          }
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
            console.warn(
              '[provider-process] inventory read unavailable',
              join(directory, name),
              error
            )
            complete = false
          }
        }
      }
    } catch (error) {
      complete = error instanceof Error && 'code' in error && error.code === 'ENOENT'
      if (!complete) {
        console.warn('[provider-process] inventory listing unavailable', directory, error)
      }
    }
    if (budget.active && namespace === directory && complete) {
      discovered = true
    }
    return budget.active && complete
  })().finally(() => {
    if (namespace === directory) {
      discovery = undefined
    }
  })
  issued?.(discovery)
  return budget.wait(discovery, false)
}

export function serializeProviderEntry(
  state: Pick<ProviderLedgerState, 'tail'>,
  action: () => Promise<void>
): Promise<void> {
  state.tail = state.tail
    .then(action)
    .catch((error: unknown) =>
      console.warn('[provider-process] ownership metadata unavailable', error)
    )
  return state.tail
}

/** Caller holds the entry tail; rename is publication, never a cross-process ownership lock. */
export async function publishProviderEntry(
  state: ProviderLedgerState,
  budget: ProviderCleanupBudget
): Promise<void> {
  const entry = state.entry
  if (!budget.active) {
    return
  }
  const path = join(entry.directory, `${entry.token}.json`)
  if (!state.local) {
    if (!mutationOwner) {
      console.warn(
        '[provider-process] recovery metadata persistence unknown: profile lock unavailable'
      )
      return
    }
    const current = await readProviderLedgerEntry(path, budget)
    const owner = await writerVerdict([entry.owner], budget)
    if (
      !current ||
      current.token !== entry.token ||
      current.createdAt !== entry.createdAt ||
      owner !== 'exited'
    ) {
      return
    }
    // The shared profile lock excludes another runtime; retain all last qualified captures.
    entry.members = current.members
    if (current.groupRetired) {
      entry.groupRetired = true
    }
  }
  await pruneProviderMembers(
    entry.members,
    budget,
    readPosixProcessRow,
    entry.groupRetired ? undefined : entry.pgid
  )
  if (!budget.active) {
    return
  }
  if (entry.groupRetired && !entry.resource) {
    entry.members.length = 0
    await unlink(path).catch(() => {})
    entries.delete(entry.token)
    return
  }
  await mkdir(entry.directory, { recursive: true })
  const temporary = `${path}.tmp`
  await writeFile(temporary, JSON.stringify(entry), { mode: 0o600, signal: budget.signal })
  if (budget.active) {
    await rename(temporary, path)
  }
}

/** All recovery consumers share four slots and one underlying flight per launch. */
export function runProviderRecovery(
  state: Pick<ProviderLedgerState, 'tail' | 'flight'>,
  budget: ProviderCleanupBudget,
  action: () => Promise<ProviderResourceResult | void>,
  issued?: (work: Promise<unknown>) => void
): Promise<ProviderResourceResult | void> {
  state.flight ??= (async () => {
    while (active >= 4 && budget.active) {
      let wake = (): void => {}
      const slot = new Promise<void>((resolve) => {
        wake = resolve
        available.add(wake)
      })
      try {
        await budget.wait(slot, undefined)
      } finally {
        available.delete(wake)
      }
    }
    if (!budget.active) {
      return 'unknown' as const
    }
    active++
    try {
      return await action()
    } finally {
      active--
      for (const wake of available) {
        wake()
      }
    }
  })().finally(() => {
    state.flight = undefined
  })
  issued?.(state.flight)
  return budget.wait(state.flight, 'unknown')
}

export const UNKNOWN_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000
export function writerVerdict(
  members: readonly ProviderGroupMember[],
  budget: ProviderCleanupBudget
) {
  return readProviderWriterVerdict(members, budget, readPosixProcessRow)
}

export function deriveObligation(
  state: ProviderLedgerState,
  kind: 'group' | 'resource',
  verdict: 'live' | 'unknown' | 'exited'
): void {
  const entry = state.entry
  entry.unknownSince ??= {}
  if (verdict === 'unknown') {
    entry.unknownSince[kind] ??= Date.now()
    if (Date.now() - entry.unknownSince[kind] < UNKNOWN_RETENTION_MS) {
      return
    }
    console.warn(`[provider-process] abandoning unknown ${kind} obligation`, entry.token)
  } else if (verdict === 'live') {
    delete entry.unknownSince[kind]
    return
  }
  delete entry.unknownSince[kind]
  if (kind === 'group') {
    entry.groupRetired = true
  } else {
    delete entry.resource
  }
  if (entry.groupRetired && !entry.resource) {
    entry.members.length = 0
  }
}
