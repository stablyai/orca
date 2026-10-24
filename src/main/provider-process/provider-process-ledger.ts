export type { ProviderLaunchRecord } from './provider-process-inventory'
export { hasRecordedProviderLaunch } from './provider-process-group'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { ProviderCleanupBudget } from './provider-process-exit-deadline'
import { readPosixProcessRow, readHostRow, pruneProviderMembers } from './provider-process-row-read'
import {
  captureProviderGroup,
  stopRecordedProviderGroup,
  type ProviderGroupMember
} from './provider-process-group'
import {
  discoverProviderLaunches,
  providerLedgerDirectory,
  providerLedgerStates,
  readProviderLedgerEntry,
  publishProviderEntry,
  runProviderRecovery,
  installProviderLedgerEntry,
  serializeProviderEntry,
  writerVerdict,
  deriveObligation,
  UNKNOWN_RETENTION_MS,
  type ProviderResource,
  type ProviderResourceResult,
  type ProviderLaunchRecord,
  type ProviderLedgerState
} from './provider-process-inventory'

async function reapEntry(
  state: ProviderLedgerState,
  budget: ProviderCleanupBudget
): Promise<ProviderResourceResult> {
  let result: ProviderResourceResult = 'unknown'
  await serializeProviderEntry(state, async () => {
    let entry = state.entry
    let resource: ProviderResourceResult = 'released'
    const owner = await writerVerdict([entry.owner], budget)
    let complete = false
    if (owner === 'exited') {
      const current = await readProviderLedgerEntry(
        join(entry.directory, `${entry.token}.json`),
        budget
      ).catch((error: unknown) => {
        console.warn(
          '[provider-process] final inventory read unavailable',
          entry.directory,
          entry.token,
          error
        )
        return null
      })
      if (!budget.active) {
        return
      }
      complete =
        current?.directory === entry.directory &&
        current.token === entry.token &&
        current.createdAt === entry.createdAt
      if (current && complete) {
        current.groupRetired ||= entry.groupRetired
        current.unknownSince = entry.unknownSince
        state.entry = entry = current
      }
    }
    const liveOwner = owner === 'live'
    if (liveOwner) {
      delete entry.unknownSince?.group
    }
    if (!entry.groupRetired && !liveOwner) {
      const owns = async (): Promise<boolean> => {
        if (!budget.active || entry.groupRetired) {
          return false
        }
        const current = await readProviderLedgerEntry(
          join(entry.directory, `${entry.token}.json`),
          budget
        ).catch(() => null)
        return (
          budget.active &&
          current?.token === entry.token &&
          current.createdAt === entry.createdAt &&
          !current.groupRetired &&
          (await writerVerdict([entry.owner], budget)) === 'exited'
        )
      }
      const verdict = !complete
        ? 'unverifiable'
        : await stopRecordedProviderGroup(entry.pgid, entry.members, owns, false, budget)
      if (!budget.active) {
        return
      }
      deriveObligation(
        state,
        'group',
        verdict === 'exited' ? 'exited' : verdict === 'live' ? 'live' : 'unknown'
      )
    }
    if (entry.resource) {
      const verdict = await writerVerdict(entry.members, budget)
      if (!budget.active) {
        return
      }
      deriveObligation(state, 'resource', complete || verdict === 'live' ? verdict : 'unknown')
      resource = !entry.resource ? 'released' : verdict === 'live' ? 'live' : 'unknown'
    }
    if (budget.active) {
      result = resource
    }
    if (!liveOwner && complete && budget.active) {
      await publishProviderEntry(state, budget)
    }
  })
  return budget.active ? result : 'unknown'
}

/** Discovery hands over residual evidence; completion of a sweep never certifies a home empty. */
export async function recoverProviderLaunches(rootPid?: number): Promise<void> {
  await startProviderRecoveryTask(rootPid).completion
}

/** The first caller owns cancellation; a scope still joins every actual shared flight. */
export function startProviderRecoveryTask(rootPid?: number) {
  const controller = new AbortController()
  const work = new Set<Promise<unknown>>()
  const issued = work.add.bind(work)
  const ready = discoverProviderLaunches(
    new ProviderCleanupBudget(Date.now() + 2_000, controller.signal),
    issued
  )
  const completion = ready.then(async (found) => {
    if (!found || controller.signal.aborted || process.platform === 'win32') {
      return
    }
    const pending = providerLedgerStates().filter(
      (state) => !state.local && (rootPid === undefined || state.entry.pgid === rootPid)
    )
    let next = 0
    await Promise.all(
      Array.from({ length: Math.min(4, pending.length) }, async () => {
        while (!controller.signal.aborted && next < pending.length) {
          const state = pending[next++]
          if (!state) {
            break
          }
          const budget = new ProviderCleanupBudget(undefined, controller.signal)
          await runProviderRecovery(state, budget, () => reapEntry(state, budget), issued)
        }
      })
    )
  })
  return {
    ready,
    completion,
    async cancelAndJoin() {
      controller.abort()
      await completion
      await Promise.all(work)
    }
  }
}

export async function verifyRecoveredProviderResources(
  key: string,
  budget: ProviderCleanupBudget
): Promise<ProviderResourceResult> {
  if (process.platform === 'win32') {
    return 'released'
  }
  const results = await Promise.all(
    providerLedgerStates()
      .filter((state) => !state.local && state.entry.resource?.key === key)
      .map(
        async (state) =>
          (await runProviderRecovery(state, budget, () => reapEntry(state, budget))) ?? 'unknown'
      )
  )
  return !budget.active || results.includes('unknown')
    ? 'unknown'
    : results.includes('live')
      ? 'live'
      : 'released'
}

/** Recording is advisory: a filesystem failure cannot refuse an agent launch. */
export function recordProviderLaunch(
  pgid: number,
  resource?: ProviderResource
): ProviderLaunchRecord {
  const token = randomUUID()
  const members: ProviderGroupMember[] = []
  let state: ProviderLedgerState | undefined
  let retired = false
  let released = false
  let unknownSince: number | undefined
  const uncaptured: Pick<ProviderLedgerState, 'tail' | 'flight'> = { tail: Promise.resolve() }
  const enqueue = (action: () => Promise<void>) => serializeProviderEntry(uncaptured, action)
  const verifyMembers = (budget: ProviderCleanupBudget) =>
    pruneProviderMembers(members, budget, readPosixProcessRow, retired ? undefined : pgid)
  const capture = (budget = new ProviderCleanupBudget(Date.now() + 2_000)): Promise<void> =>
    enqueue(async () => {
      if (retired || !budget.active) {
        return
      }
      await verifyMembers(budget)
      const observed = await captureProviderGroup(pgid, true, budget)
      if (retired || !budget.active) {
        return
      }
      const root = members.find((member) => member.pid === pgid)
      if (root && !observed.some((row) => row.pid === pgid && row.startedAt === root.startedAt)) {
        return
      }
      for (const row of observed) {
        const old = members.find((old) => old.pid === row.pid && old.startedAt === row.startedAt)
        if (old) {
          members[members.indexOf(old)] = { ...old }
        } else {
          members.push(row)
        }
      }
      if (!members.length) {
        return
      }
      const owner = await readHostRow(budget, readPosixProcessRow)
      if (!owner) {
        return
      }
      state ??= installProviderLedgerEntry(
        {
          version: 1,
          origin: 'direct',
          token,
          directory: providerLedgerDirectory(),
          createdAt: Date.now(),
          pgid,
          owner,
          members,
          ...(resource && !released ? { resource } : {})
        },
        true
      )
      const current = state
      await serializeProviderEntry(current, async () => {
        if (retired || current.entry.groupRetired) {
          return
        }
        current.entry.members = members
        await publishProviderEntry(current, budget)
      })
    })
  void capture()
  return {
    capture,
    async verifyResource(budget) {
      const verdict = await verifyMembers(budget)
      if (!budget.active) {
        return 'unknown'
      }
      if (state && resource) {
        const current = state
        deriveObligation(current, 'resource', verdict)
        released = !current.entry.resource
        void serializeProviderEntry(current, () => publishProviderEntry(current, budget))
        return released ? 'released' : verdict === 'live' ? 'live' : 'unknown'
      }
      if (verdict === 'live') {
        unknownSince = undefined
      }
      if (verdict === 'unknown') {
        unknownSince ??= Date.now()
        if (Date.now() - unknownSince < UNKNOWN_RETENTION_MS) {
          return 'unknown'
        }
        console.warn('[provider-process] abandoning unpersisted unknown resource obligation', token)
        if (retired) {
          members.length = 0
        }
        return 'released'
      }
      return verdict === 'exited' ? 'released' : 'live'
    },
    cleanup: async (budget, action) => {
      await runProviderRecovery(state ?? uncaptured, budget, action)
    },
    members: () => members,
    retire: () => {
      retired = true
      const current = state
      if (current) {
        current.entry.groupRetired = true
      }
      return verifyMembers(new ProviderCleanupBudget()).then(() => {
        if (!resource || released) {
          members.length = 0
        }
        return current
          ? enqueue(() =>
              serializeProviderEntry(current, () =>
                publishProviderEntry(current, new ProviderCleanupBudget())
              )
            )
          : undefined
      })
    }
  }
}
