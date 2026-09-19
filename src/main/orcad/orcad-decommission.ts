import type { OrcadDecommissionResult } from '../../shared/orcad-decommission'
import { homedir } from 'node:os'
import {
  OrcadManagedStopRequestSchema,
  type OrcadManagedStopRequest
} from '../../shared/orcad-managed-stop-request'
import type { OrcadManagedStopCancellationResult } from '../../shared/orcad-managed-stop-cancellation'
import { persistOrcadCanceledStopReceipt } from './orcad-canceled-stop-receipt'
import {
  recordOrcadManagedStopDispatch,
  wasOrcadManagedStopDispatched
} from './orcad-managed-stop-dispatch'
import {
  OrcadManagedStopInstanceSchema,
  sameOrcadManagedStopInstance,
  type OrcadManagedStopInstance
} from '../../shared/orcad-managed-stop-instance'
import {
  OrcadManagedStopRuntimeIdentitySchema,
  sameOrcadManagedStopAuthority,
  type OrcadManagedStopAuthority,
  type OrcadManagedStopRuntimeIdentity
} from '../../shared/orcad-managed-stop-authority'
import {
  OrcadManagedDecommissionParamsSchema,
  type OrcadManagedDecommissionParams,
  type OrcadManagedDecommissionResult
} from '../../shared/orcad-managed-decommission'
import {
  persistOrcadDecommissionAcceptance,
  validateOrcadDecommissionCancellation,
  validateOrcadDecommissionTransaction
} from './orcad-decommission-acceptance'

type OrcadDecommissionAdapter = (
  authority?: OrcadManagedStopAuthority
) => Promise<OrcadDecommissionResult>

let adapter: OrcadDecommissionAdapter | null = null
let runningIdentity: Readonly<OrcadManagedStopRuntimeIdentity> | null = null
let runningInstance: Readonly<OrcadManagedStopInstance> | null = null
let operationPending = false
let configurationGeneration = 0
let assertNativeReopened: ((authority: OrcadManagedStopAuthority) => void) | null = null

export function configureOrcadDecommission(
  next: OrcadDecommissionAdapter | null,
  identity?: OrcadManagedStopRuntimeIdentity,
  instance?: OrcadManagedStopInstance,
  confirmNativeReopening?: (authority: OrcadManagedStopAuthority) => void
): void {
  const validated = identity
    ? Object.freeze(OrcadManagedStopRuntimeIdentitySchema.parse(identity))
    : null
  const validatedInstance = instance
    ? Object.freeze(OrcadManagedStopInstanceSchema.parse(instance))
    : null
  if (validatedInstance && !validated) {
    throw new Error('orcad_managed_stop_identity_unavailable')
  }
  adapter = next
  configurationGeneration += 1
  runningIdentity = next ? validated : null
  runningInstance = next ? validatedInstance : null
  assertNativeReopened = next ? (confirmNativeReopening ?? null) : null
}

export function requestOrcadManagedStopCancellation(
  params: OrcadManagedStopRequest,
  runningVersion: string,
  runtimeId: string
): OrcadManagedStopCancellationResult {
  const request = OrcadManagedStopRequestSchema.parse(params)
  if (
    !adapter ||
    !runningIdentity ||
    !runningInstance ||
    !assertNativeReopened ||
    runtimeId !== runningIdentity.runtimeId ||
    request.version !== runningVersion ||
    !sameOrcadManagedStopInstance(request.instance, runningInstance) ||
    !sameOrcadManagedStopAuthority(request.authority, {
      ...runningIdentity,
      transactionId: request.authority.transactionId
    })
  ) {
    return authorityUnavailable()
  }
  if (operationPending) {
    return pendingOperationRefusal()
  }
  operationPending = true
  const generation = configurationGeneration
  try {
    validateOrcadDecommissionCancellation(request.authority, request.version, request.instance)
    if (wasOrcadManagedStopDispatched(request)) {
      assertNativeReopened(request.authority)
    }
    if (generation !== configurationGeneration) {
      throw new Error('Runtime configuration changed during cancellation validation.')
    }
    persistOrcadCanceledStopReceipt(homedir(), request)
    return { ...request, outcome: 'canceled' }
  } catch (error) {
    return {
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'orcad_stop_cancellation_unverifiable',
      reason: `Cancellation could not be durably verified: ${error instanceof Error ? error.message : String(error)}`
    }
  } finally {
    operationPending = false
  }
}

export function getOrcadManagedStopIdentity(runtimeId: string, version: string) {
  if (!adapter || !runningIdentity || runningIdentity.runtimeId !== runtimeId) {
    throw new Error('orcad_managed_stop_identity_unavailable')
  }
  return {
    version,
    completedStopReceipt: 1 as const,
    ...(assertNativeReopened && runningInstance ? { cancelPreparedStop: 1 as const } : {}),
    identity: { ...runningIdentity },
    ...(runningInstance ? { instance: { ...runningInstance } } : {})
  }
}

export async function requestOrcadManagedDecommission(
  params: OrcadManagedDecommissionParams,
  runningVersion: string,
  runtimeId: string
): Promise<OrcadManagedDecommissionResult> {
  const { version, authority: requested } = OrcadManagedDecommissionParamsSchema.parse(params)
  const authority = Object.freeze(requested)
  if (
    !runningIdentity ||
    runningIdentity.runtimeId !== runtimeId ||
    !sameOrcadManagedStopAuthority(authority, {
      ...runningIdentity,
      transactionId: authority.transactionId
    })
  ) {
    return authorityUnavailable()
  }
  const result = await executeOrcadDecommission(
    version,
    runningVersion,
    authority.transactionId,
    authority
  )
  return result.outcome === 'accepted'
    ? { outcome: 'accepted', transactionId: authority.transactionId, authority }
    : result
}

export async function requestOrcadDecommission(
  expectedVersion: string,
  runningVersion: string,
  transactionId?: string
): Promise<OrcadDecommissionResult> {
  if (runningIdentity) {
    return authorityUnavailable()
  }
  return executeOrcadDecommission(expectedVersion, runningVersion, transactionId)
}

async function executeOrcadDecommission(
  expectedVersion: string,
  runningVersion: string,
  transactionId?: string,
  authority?: OrcadManagedStopAuthority
): Promise<OrcadDecommissionResult> {
  if (operationPending) {
    return pendingOperationRefusal()
  }
  operationPending = true
  try {
    return await executeExclusiveOrcadDecommission(
      expectedVersion,
      runningVersion,
      transactionId,
      authority
    )
  } finally {
    operationPending = false
  }
}

async function executeExclusiveOrcadDecommission(
  expectedVersion: string,
  runningVersion: string,
  transactionId?: string,
  authority?: OrcadManagedStopAuthority
): Promise<OrcadDecommissionResult> {
  const generation = configurationGeneration
  if (!adapter) {
    return {
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'orcad_decommission_unavailable',
      reason: 'This runtime does not expose the managed orcad decommission contract.'
    }
  }
  if (expectedVersion !== runningVersion) {
    return {
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'orcad_decommission_version_mismatch',
      reason:
        `The managed activation record names orcad ${expectedVersion}, but the contacted ` +
        `runtime is ${runningVersion}. Refresh the server status before stopping it.`
    }
  }
  let transactionSnapshot: string | undefined
  if (transactionId) {
    try {
      const validated = validateOrcadDecommissionTransaction(
        transactionId,
        expectedVersion,
        undefined,
        undefined,
        authority
      )
      if (
        authority &&
        (!runningInstance ||
          !validated.instance ||
          !sameOrcadManagedStopInstance(runningInstance, validated.instance))
      ) {
        throw new Error('The managed-stop transaction belongs to a different runtime instance.')
      }
      transactionSnapshot = validated.transactionSnapshot
    } catch (error) {
      return {
        outcome: 'refused',
        verdict: 'unverifiable',
        code: 'orcad_decommission_transaction_unverifiable',
        reason: `The managed-stop transaction could not be verified before terminal admission was changed: ${error instanceof Error ? error.message : String(error)}`
      }
    }
  }
  if (authority && runningInstance) {
    recordOrcadManagedStopDispatch(expectedVersion, authority, runningInstance)
  }
  const result = await (authority ? adapter(authority) : adapter())
  if (generation !== configurationGeneration) {
    return {
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'orcad_decommission_configuration_changed',
      reason:
        'The runtime configuration changed during retirement; original-host recovery is required.'
    }
  }
  if (result.outcome === 'refused' || !transactionId) {
    return result
  }
  try {
    persistOrcadDecommissionAcceptance(
      transactionId,
      expectedVersion,
      undefined,
      transactionSnapshot,
      authority
    )
    return { outcome: 'accepted', transactionId }
  } catch (error) {
    return {
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'orcad_decommission_receipt_unverifiable',
      reason:
        `Terminal admission is fenced, but the durable managed-stop receipt could not be ` +
        `written: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

function authorityUnavailable(): Extract<OrcadDecommissionResult, { outcome: 'refused' }> {
  return {
    outcome: 'refused',
    verdict: 'unverifiable',
    code: 'orcad_decommission_authority_unavailable',
    reason:
      'Managed stop requires the exact identity-bound runtime, profile and transaction contract.'
  }
}

function pendingOperationRefusal(): Extract<OrcadDecommissionResult, { outcome: 'refused' }> {
  return {
    outcome: 'refused',
    verdict: 'unverifiable',
    code: 'orcad_decommission_operation_pending',
    reason:
      'Another stop operation is still validating, retiring, canceling, or persisting its receipt.'
  }
}
