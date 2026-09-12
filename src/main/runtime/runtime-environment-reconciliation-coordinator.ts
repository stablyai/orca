import { resolveEnvironment } from '../../shared/runtime-environment-store'
import { setRuntimeEnvironmentReconciliationCatalogActive } from '../../shared/runtime-environment-reconciliation-catalog'
import { cancelPreparedRuntimeEnvironmentReconciliation } from '../../shared/runtime-environment-reconciliation-store'
import { runRuntimeEnvironmentReconciliationLifecycle } from './runtime-environment-reconciliation-lifecycle'
import { verifyRuntimeEnvironmentReconciliation } from './runtime-environment-reconciliation-verification'
import type { RuntimeEnvironmentReconciliationRecord } from '../../shared/runtime-environment-reconciliation-record'
import { holdIdleRuntimeEnvironmentCalls } from '../ipc/runtime-environment-call-queue'

type ReconciliationSelection = { environmentId: string; requestId: string; signal?: AbortSignal }

function selectedReconciliation(userDataPath: string, args: ReconciliationSelection) {
  const environment = resolveEnvironment(userDataPath, args.environmentId)
  const record = environment.reconciliation
  if (!record || record.requestId !== args.requestId) {
    throw new Error('The runtime reconciliation no longer matches this operation.')
  }
  const registrations = record.registrations.map((entry) =>
    resolveEnvironment(userDataPath, entry.environmentId)
  )
  return { record, registrations }
}

function assertSameReconciliation(
  initial: RuntimeEnvironmentReconciliationRecord,
  current: RuntimeEnvironmentReconciliationRecord
): void {
  if (JSON.stringify({ ...initial, stage: current.stage }) !== JSON.stringify(current)) {
    throw new Error('Runtime reconciliation changed while waiting for lifecycle locks.')
  }
}

/** Catalog activation only; historical request grants and browser ownership remain unchanged. */
export async function transitionRuntimeEnvironmentReconciliationCatalog(
  userDataPath: string,
  args: ReconciliationSelection & { active: boolean },
  retireControlTransport: (environmentId: string) => void
) {
  args.signal?.throwIfAborted()
  const initial = selectedReconciliation(userDataPath, args)
  return runRuntimeEnvironmentReconciliationLifecycle(
    userDataPath,
    initial.registrations,
    async () => {
      args.signal?.throwIfAborted()
      const current = selectedReconciliation(userDataPath, args)
      assertSameReconciliation(initial.record, current.record)
      const stage = args.active ? 'catalog-active' : 'prepared'
      if (current.record.stage === stage) {
        return current.record
      }
      if (args.active) {
        const [left, right] = current.registrations
        const verified = await verifyRuntimeEnvironmentReconciliation(userDataPath, {
          selectors: [left.id, right.id],
          signal: args.signal
        })
        if (verified.runtimeId !== current.record.runtimeId) {
          throw new Error('The authenticated host no longer matches the prepared reconciliation.')
        }
      }
      args.signal?.throwIfAborted()
      const assertUnchanged = (): void => {
        if (
          JSON.stringify(selectedReconciliation(userDataPath, args).record) !==
          JSON.stringify(current.record)
        ) {
          throw new Error('Runtime reconciliation changed during catalog transition.')
        }
      }
      assertUnchanged()
      const releaseCalls = holdIdleRuntimeEnvironmentCalls(
        current.registrations.map((registration) => registration.id)
      )
      try {
        // Fence both generations before publication; partial retirement must never activate the catalog.
        const failures: unknown[] = []
        for (const registration of current.registrations) {
          try {
            retireControlTransport(registration.id)
          } catch (error) {
            failures.push(error)
          }
        }
        if (failures.length > 0) {
          throw new AggregateError(
            failures,
            'Could not retire runtime control connections; retry reconciliation.'
          )
        }
        args.signal?.throwIfAborted()
        assertUnchanged()
        return setRuntimeEnvironmentReconciliationCatalogActive(userDataPath, args)
      } finally {
        releaseCalls()
      }
    }
  )
}

export async function cancelRuntimeEnvironmentReconciliation(
  userDataPath: string,
  args: ReconciliationSelection
): Promise<void> {
  args.signal?.throwIfAborted()
  const initial = selectedReconciliation(userDataPath, args)
  await runRuntimeEnvironmentReconciliationLifecycle(
    userDataPath,
    initial.registrations,
    async () => {
      args.signal?.throwIfAborted()
      assertSameReconciliation(initial.record, selectedReconciliation(userDataPath, args).record)
      cancelPreparedRuntimeEnvironmentReconciliation(userDataPath, args)
    }
  )
}
