import { isDesktopScriptProviderRequest } from './desktop-script-provider-request-validation'
import type { BridgeRequest } from './desktop-script-provider-types'

export const COMPUTER_PROVIDER_SUPERVISOR_CHANNEL = 'orca:computer-provider-supervisor'

export type ComputerProviderSupervisorRequest =
  | {
      channel: typeof COMPUTER_PROVIDER_SUPERVISOR_CHANNEL
      kind: 'request'
      id: number
      method: 'macos.start'
      params: Record<string, never>
    }
  | {
      channel: typeof COMPUTER_PROVIDER_SUPERVISOR_CHANNEL
      kind: 'request'
      id: number
      method: 'macos.claim' | 'macos.release'
      params: { sessionId: string }
    }
  | {
      channel: typeof COMPUTER_PROVIDER_SUPERVISOR_CHANNEL
      kind: 'request'
      id: number
      method: 'desktop.execute'
      params: { request: BridgeRequest }
    }

export type ComputerProviderSupervisorResponse =
  | {
      channel: typeof COMPUTER_PROVIDER_SUPERVISOR_CHANNEL
      kind: 'response'
      id: number
      ok: true
      result: unknown
    }
  | {
      channel: typeof COMPUTER_PROVIDER_SUPERVISOR_CHANNEL
      kind: 'response'
      id: number
      ok: false
      error: { code: string; message: string }
    }

export type ComputerProviderSupervisorEvent = {
  channel: typeof COMPUTER_PROVIDER_SUPERVISOR_CHANNEL
  kind: 'event'
  event: 'macos.sessionTerminated'
  sessionId: string
  error: { code: string; message: string }
}

export type ComputerProviderSupervisorMessage =
  | ComputerProviderSupervisorResponse
  | ComputerProviderSupervisorEvent

export type StartedSupervisedMacOSProvider = {
  sessionId: string
  socketPath: string
  socketToken: string
}

export type SupervisedDesktopProviderResult = {
  stdout: string
  stderr: string
  error: { message: string; killed: boolean } | null
}

const REQUEST_KEYS = new Set(['channel', 'kind', 'id', 'method', 'params'])

export function isComputerProviderSupervisorRequest(
  value: unknown
): value is ComputerProviderSupervisorRequest {
  const record = messageRecord(value)
  if (
    !record ||
    record.channel !== COMPUTER_PROVIDER_SUPERVISOR_CHANNEL ||
    record.kind !== 'request' ||
    !Number.isSafeInteger(record.id) ||
    typeof record.method !== 'string' ||
    !hasOnlyKeys(record, REQUEST_KEYS)
  ) {
    return false
  }
  const params = messageRecord(record.params)
  if (!params) {
    return false
  }
  if (record.method === 'macos.start') {
    return Object.keys(params).length === 0
  }
  if (record.method === 'macos.claim' || record.method === 'macos.release') {
    return (
      typeof params.sessionId === 'string' &&
      params.sessionId.length > 0 &&
      Object.keys(params).length === 1
    )
  }
  if (record.method === 'desktop.execute') {
    return Object.keys(params).length === 1 && isDesktopScriptProviderRequest(params.request)
  }
  return false
}

export function isComputerProviderSupervisorMessage(
  value: unknown
): value is ComputerProviderSupervisorMessage {
  const record = messageRecord(value)
  if (!record || record.channel !== COMPUTER_PROVIDER_SUPERVISOR_CHANNEL) {
    return false
  }
  if (record.kind === 'event') {
    return (
      record.event === 'macos.sessionTerminated' &&
      typeof record.sessionId === 'string' &&
      isErrorPayload(record.error)
    )
  }
  if (record.kind !== 'response' || !Number.isSafeInteger(record.id)) {
    return false
  }
  return record.ok === true || (record.ok === false && isErrorPayload(record.error))
}

export function isStartedSupervisedMacOSProvider(
  value: unknown
): value is StartedSupervisedMacOSProvider {
  const record = messageRecord(value)
  return (
    !!record &&
    typeof record.sessionId === 'string' &&
    record.sessionId.length > 0 &&
    typeof record.socketPath === 'string' &&
    record.socketPath.length > 0 &&
    typeof record.socketToken === 'string' &&
    record.socketToken.length > 0
  )
}

export function isSupervisedDesktopProviderResult(
  value: unknown
): value is SupervisedDesktopProviderResult {
  const record = messageRecord(value)
  if (
    !record ||
    !hasOnlyKeys(record, new Set(['stdout', 'stderr', 'error'])) ||
    typeof record.stdout !== 'string' ||
    typeof record.stderr !== 'string'
  ) {
    return false
  }
  if (record.error === null) {
    return true
  }
  const error = messageRecord(record.error)
  return (
    !!error &&
    hasOnlyKeys(error, new Set(['message', 'killed'])) &&
    typeof error.message === 'string' &&
    typeof error.killed === 'boolean'
  )
}

function isErrorPayload(value: unknown): value is { code: string; message: string } {
  const record = messageRecord(value)
  return !!record && typeof record.code === 'string' && typeof record.message === 'string'
}

function messageRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}
