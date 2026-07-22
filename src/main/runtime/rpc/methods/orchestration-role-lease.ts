import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalString, requiredString } from '../schemas'
import {
  assertCoordinatorControlAllowed,
  coordinatorControlOpForMessageType,
  isEquivalentOrchestrationPaneKey,
  type OrchestrationCallerIdentity
} from '../../orchestration/role-lease'
import type { OrchestrationDb } from '../../orchestration/db'
import type { OrcaRuntimeService } from '../../orca-runtime'

const CallerIdentityParams = {
  callerTerminalHandle: OptionalString,
  callerPaneKey: OptionalString
}

export const RoleLeaseGrantParams = z.object({
  to: requiredString('Missing --to'),
  from: OptionalString,
  subjectPaneKey: OptionalString,
  ...CallerIdentityParams
})

export function resolveCallerIdentity(
  db: OrchestrationDb,
  runtime: OrcaRuntimeService,
  params: {
    callerTerminalHandle?: string
    callerPaneKey?: string
    from?: string
    senderPaneKey?: string
  }
): OrchestrationCallerIdentity {
  const claimedHandle = params.callerTerminalHandle ?? params.from ?? undefined
  const claimedPaneKey =
    params.callerPaneKey ??
    params.senderPaneKey ??
    (claimedHandle ? (runtime.getTerminalPaneKey(claimedHandle) ?? undefined) : undefined)

  if (!claimedHandle && !claimedPaneKey) {
    return {}
  }

  // After the first dispatch, bind request claims to the runtime's live pane map.
  if (!db.hasAnyDispatchContexts()) {
    return { handle: claimedHandle, paneKey: claimedPaneKey }
  }

  if (claimedHandle) {
    const runtimePaneKey = runtime.getTerminalPaneKey(claimedHandle) ?? undefined
    if (!runtimePaneKey) {
      return {}
    }
    if (claimedPaneKey && !isEquivalentOrchestrationPaneKey(runtimePaneKey, claimedPaneKey)) {
      return {}
    }
    return { handle: claimedHandle, paneKey: runtimePaneKey }
  }

  if (!claimedPaneKey) {
    return {}
  }
  try {
    const terminal = runtime.resolveTerminalPane(claimedPaneKey)
    return { handle: terminal.handle, paneKey: claimedPaneKey }
  } catch {
    return {}
  }
}

export function assertCallerCoordinatorControl(
  db: OrchestrationDb,
  runtime: OrcaRuntimeService,
  params: {
    callerTerminalHandle?: string
    callerPaneKey?: string
    from?: string
    senderPaneKey?: string
  },
  operation: Parameters<typeof assertCoordinatorControlAllowed>[2]
): void {
  assertCoordinatorControlAllowed(db, resolveCallerIdentity(db, runtime, params), operation)
}

export function assertSenderCoordinatorMessageAllowed(
  db: OrchestrationDb,
  runtime: OrcaRuntimeService,
  params: {
    from?: string
    senderPaneKey?: string
    callerTerminalHandle?: string
    callerPaneKey?: string
    type?: string
  }
): void {
  const op = coordinatorControlOpForMessageType(params.type)
  if (!op) {
    return
  }
  assertCallerCoordinatorControl(db, runtime, params, op)
}

export const ORCHESTRATION_ROLE_LEASE_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.roleLeaseGrant',
    params: RoleLeaseGrantParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      // Why: only an unscoped/coordinator caller may mint a handoff lease; workers cannot self-promote.
      assertCallerCoordinatorControl(db, runtime, params, 'roleLeaseGrant')

      const subjectPaneKey =
        params.subjectPaneKey ?? runtime.getTerminalPaneKey(params.to) ?? undefined
      const lease = db.grantCoordinatorRoleLease({
        subjectHandle: params.to,
        subjectPaneKey,
        grantedByHandle: params.from ?? params.callerTerminalHandle
      })
      return { lease }
    }
  })
]
