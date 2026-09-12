import { TransportPublicationDrain } from '../../shared/transport-publication-drain'
import { assertProfileLifetimeAdmission } from '../ssh/profile-lifetime-admission'
import type { BrowserNetworkExecutionRoute } from './browser-network-execution-route'
import {
  parseRelayOwnerResetRequest,
  type RelayOwnerResetRequest
} from '../../shared/relay-owner-reset-contract'

type ResetBinding = {
  connection: object
  tunnel: { readonly resetRetirementRequest?: RelayOwnerResetRequest }
}
type RouteEntry = {
  binding?: ResetBinding
  closed: boolean
  retired: boolean
  retire: () => void
}
type Target = { drain: TransportPublicationDrain; entries: Set<RouteEntry>; revision: number }
const targets = new Map<string, Target>()

export type SshBrowserRouteAllocation = {
  started: boolean
  retirementConfirmed: () => boolean
  resetBinding?: ResetBinding
}

export function assertSshBrowserResourcesAbsent(targetId: string): void {
  targets.get(targetId)?.drain.assertDrained()
}

/** Retains local resource evidence independently of authority abort registrations. */
export async function retainSshBrowserRoute(
  targetId: string,
  open: (allocation: SshBrowserRouteAllocation) => Promise<BrowserNetworkExecutionRoute>
): Promise<BrowserNetworkExecutionRoute> {
  assertProfileLifetimeAdmission()
  const target = targets.get(targetId) ?? {
    drain: new TransportPublicationDrain(() => {}),
    entries: new Set<RouteEntry>(),
    revision: 0
  }
  const { drain } = target
  targets.set(targetId, target)
  target.revision++
  const settle = drain.trackWrite()
  const entry: RouteEntry = { closed: false, retired: false, retire: () => retired() }
  target.entries.add(entry)
  const retired = () => {
    entry.retired = true
    target.entries.delete(entry)
    settle({ ok: true })
    try {
      drain.assertDrained()
      if (targets.get(targetId) === target) {
        targets.delete(targetId)
      }
    } catch {
      // Other routes or unconfirmed failures still own this target's evidence.
    }
  }
  const failed = (error: unknown) =>
    settle({ ok: false, error: error instanceof Error ? error : new Error(String(error)) })
  const allocation: SshBrowserRouteAllocation = {
    started: false,
    retirementConfirmed: () => true
  }
  let route: BrowserNetworkExecutionRoute
  try {
    route = await open(allocation)
    if (allocation.resetBinding) {
      entry.binding = Object.freeze({ ...allocation.resetBinding })
      target.revision++
    }
  } catch (error) {
    if (!allocation.started) {
      retired()
    } else {
      failed(error)
    }
    throw error
  }
  let closing: Promise<void> | undefined
  return {
    ...route,
    close: () => {
      if (closing) {
        return closing
      }
      const completion = Promise.withResolvers<void>()
      closing = completion.promise
      const finish = async () => {
        await route.close()
        entry.closed = true
        // A reset-fenced tunnel can drain successfully without being retired.
        if (allocation.retirementConfirmed()) {
          retired()
        }
      }
      void finish().then(completion.resolve, (error) => {
        failed(error)
        completion.reject(error)
      })
      return closing
    }
  }
}

/** Preparation identifies the cohort; only the caller's exact transport proof permits retirement. */
export function captureSshBrowserResetRetirement(options: {
  targetId: string
  connection: object
  request: RelayOwnerResetRequest
  assertAuthority: () => void
}) {
  const { targetId, connection, assertAuthority } = options
  const request = JSON.stringify(parseRelayOwnerResetRequest(options.request))
  assertAuthority()
  const target = targets.get(targetId)
  const revision = target?.revision
  const selected = [...(target?.entries ?? [])].filter(
    (entry) => entry.binding?.connection === connection
  )
  let reconciled = false
  const assertCohort = () => {
    assertAuthority()
    const current = targets.get(targetId)
    if ((current !== target && current !== undefined) || target?.revision !== revision) {
      throw new Error('ssh_browser_reset_cohort_changed')
    }
    target?.drain.assertCurrent()
    if ([...(target?.entries ?? [])].some((entry) => !entry.binding)) {
      throw new Error('ssh_browser_reset_route_binding_unconfirmed')
    }
    for (const entry of selected) {
      if (!entry.retired && !target?.entries.has(entry)) {
        throw new Error('ssh_browser_reset_cohort_changed')
      }
    }
  }
  const assertClosed = () => {
    assertCohort()
    for (const entry of selected) {
      if (entry.retired) {
        continue
      }
      if (!entry.closed || !entry.binding || entry.binding.connection !== connection) {
        throw new Error('ssh_browser_reset_local_close_unconfirmed')
      }
      if (
        JSON.stringify(parseRelayOwnerResetRequest(entry.binding.tunnel.resetRetirementRequest)) !==
        request
      ) {
        throw new Error('ssh_browser_reset_request_changed')
      }
    }
    assertCohort()
  }
  assertCohort()
  return {
    assertCurrent: assertCohort,
    reconcile: (assertTransportRetired: () => void) => {
      assertTransportRetired()
      assertClosed()
      assertTransportRetired()
      assertClosed()
      try {
        for (const entry of selected) {
          entry.retire()
        }
        assertCohort()
        assertTransportRetired()
        reconciled = true
      } catch (error) {
        if (target && selected.length > 0) {
          const failure = error instanceof Error ? error : new Error(String(error))
          target.drain.fail(failure)
          const current = targets.get(targetId)
          if (current) {
            current.drain.fail(failure)
          } else {
            targets.set(targetId, target)
          }
        }
        throw error
      }
    },
    assertReconciled: () => {
      assertCohort()
      if (!reconciled || selected.some((entry) => !entry.retired)) {
        throw new Error('ssh_browser_reset_retirement_unconfirmed')
      }
    }
  }
}
