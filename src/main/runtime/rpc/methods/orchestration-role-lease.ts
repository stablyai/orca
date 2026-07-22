import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalString, requiredString } from '../schemas'
import {
  assertCoordinatorControlAllowed,
  coordinatorControlOpForMessageType,
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
  runtime: OrcaRuntimeService,
  params: {
    callerTerminalHandle?: string
    callerPaneKey?: string
    from?: string
    senderPaneKey?: string
  }
): OrchestrationCallerIdentity {
  const handle = params.callerTerminalHandle ?? params.from ?? undefined
  const paneKey =
    params.callerPaneKey ??
    params.senderPaneKey ??
    (handle ? (runtime.getTerminalPaneKey(handle) ?? undefined) : undefined)
  return { handle, paneKey }
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
  assertCoordinatorControlAllowed(db, resolveCallerIdentity(runtime, params), operation)
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
