import { measureUtf8ByteLength } from '../../shared/utf8-byte-limits'
import { terminalSizeAdmissionError } from '../../shared/terminal-size-limits'

export const DAEMON_MAX_TRANSPORT_SOCKETS = 128
export const DAEMON_MAX_CONTROL_CLIENTS = 32
export const DAEMON_MAX_STREAM_ATTACHMENTS = 24
export const DAEMON_HANDSHAKE_TIMEOUT_MS = 10_000

export const DAEMON_MAX_ACTIVE_REQUESTS = 256
export const DAEMON_MAX_ACTIVE_REQUESTS_PER_CLIENT = 128
export const DAEMON_MAX_ACTIVE_REQUEST_BYTES = 32 * 1024 * 1024
export const DAEMON_MAX_ACTIVE_REQUEST_BYTES_PER_CLIENT = 16 * 1024 * 1024
export const DAEMON_CONTROL_SOCKET_MAX_BUFFERED_BYTES = 32 * 1024 * 1024

export const DAEMON_CLIENT_ID_MAX_BYTES = 1024
export const DAEMON_REQUEST_ID_MAX_BYTES = 1024
export const DAEMON_REQUEST_TYPE_MAX_BYTES = 256
export const DAEMON_SESSION_ID_MAX_BYTES = 4 * 1024
export const DAEMON_PTY_CWD_MAX_BYTES = 256 * 1024
export const DAEMON_PTY_COMMAND_MAX_BYTES = 4 * 1024 * 1024
export const DAEMON_PTY_HISTORY_SEED_MAX_BYTES = 12 * 1024 * 1024
export const DAEMON_PTY_ENV_MAX_ENTRIES = 4096
export const DAEMON_PTY_ENV_NAME_MAX_BYTES = 32 * 1024
export const DAEMON_PTY_ENV_VALUE_MAX_BYTES = 1024 * 1024
export const DAEMON_PTY_ENV_MAX_BYTES = 4 * 1024 * 1024
export const DAEMON_PTY_ENV_DELETE_MAX_ENTRIES = 4096
export const DAEMON_PTY_ENV_DELETE_MAX_BYTES = 1024 * 1024

const REQUESTS_WITH_SESSION_ID = new Set([
  'cancelCreateOrAttach',
  'closeStartupQueryAuthority',
  'write',
  'resize',
  'pausePty',
  'resumePty',
  'setSessionBackground',
  'kill',
  'signal',
  'detach',
  'getCwd',
  'getForegroundProcess',
  'confirmForegroundProcess',
  'clearScrollback',
  'getSnapshot',
  'getSize',
  'takePendingOutput'
])

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedStringError(
  value: unknown,
  field: string,
  maxBytes: number,
  options: { nonEmpty?: boolean; forbidNull?: boolean } = {}
): string | null {
  if (typeof value !== 'string') {
    return `${field} must be a string`
  }
  if (options.nonEmpty && value.length === 0) {
    return `${field} must not be empty`
  }
  if (options.forbidNull && value.includes('\0')) {
    return `${field} must not contain NUL`
  }
  if (
    value.length > maxBytes ||
    measureUtf8ByteLength(value, { stopAfterBytes: maxBytes }).exceededLimit
  ) {
    return `${field} exceeds ${maxBytes} bytes`
  }
  return null
}

function optionalBoundedStringError(
  value: unknown,
  field: string,
  maxBytes: number
): string | null {
  return value === undefined ? null : boundedStringError(value, field, maxBytes)
}

function optionalNullableBoundedStringError(
  value: unknown,
  field: string,
  maxBytes: number
): string | null {
  return value === undefined || value === null ? null : boundedStringError(value, field, maxBytes)
}

function createEnvironmentError(env: unknown): string | null {
  if (env === undefined) {
    return null
  }
  if (!isRecord(env)) {
    return 'createOrAttach payload.env must be a string record'
  }

  let entries = 0
  let retainedBytes = 0
  for (const name in env) {
    if (!Object.prototype.hasOwnProperty.call(env, name)) {
      continue
    }
    entries += 1
    if (entries > DAEMON_PTY_ENV_MAX_ENTRIES) {
      return `createOrAttach payload.env exceeds ${DAEMON_PTY_ENV_MAX_ENTRIES} entries`
    }
    const nameError = boundedStringError(
      name,
      'createOrAttach payload.env name',
      DAEMON_PTY_ENV_NAME_MAX_BYTES
    )
    if (nameError) {
      return nameError
    }
    const value = env[name]
    const valueError = boundedStringError(
      value,
      'createOrAttach payload.env value',
      DAEMON_PTY_ENV_VALUE_MAX_BYTES
    )
    if (valueError) {
      return valueError
    }
    retainedBytes +=
      measureUtf8ByteLength(name).byteLength + measureUtf8ByteLength(value as string).byteLength
    if (retainedBytes > DAEMON_PTY_ENV_MAX_BYTES) {
      return `createOrAttach payload.env exceeds ${DAEMON_PTY_ENV_MAX_BYTES} bytes`
    }
  }
  return null
}

function createEnvironmentDeleteError(envToDelete: unknown): string | null {
  if (envToDelete === undefined) {
    return null
  }
  if (!Array.isArray(envToDelete)) {
    return 'createOrAttach payload.envToDelete must be a string array'
  }
  if (envToDelete.length > DAEMON_PTY_ENV_DELETE_MAX_ENTRIES) {
    return `createOrAttach payload.envToDelete exceeds ${DAEMON_PTY_ENV_DELETE_MAX_ENTRIES} entries`
  }

  let retainedBytes = 0
  for (const name of envToDelete) {
    const nameError = boundedStringError(
      name,
      'createOrAttach payload.envToDelete entry',
      DAEMON_PTY_ENV_NAME_MAX_BYTES
    )
    if (nameError) {
      return nameError
    }
    retainedBytes += measureUtf8ByteLength(name as string).byteLength
    if (retainedBytes > DAEMON_PTY_ENV_DELETE_MAX_BYTES) {
      return `createOrAttach payload.envToDelete exceeds ${DAEMON_PTY_ENV_DELETE_MAX_BYTES} bytes`
    }
  }
  return null
}

function createOrAttachPayloadError(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return 'createOrAttach payload must be an object'
  }

  const checks = [
    () =>
      boundedStringError(
        payload.sessionId,
        'createOrAttach payload.sessionId',
        DAEMON_SESSION_ID_MAX_BYTES,
        { nonEmpty: true, forbidNull: true }
      ),
    () =>
      optionalBoundedStringError(
        payload.cwd,
        'createOrAttach payload.cwd',
        DAEMON_PTY_CWD_MAX_BYTES
      ),
    () =>
      optionalBoundedStringError(
        payload.command,
        'createOrAttach payload.command',
        DAEMON_PTY_COMMAND_MAX_BYTES
      ),
    () =>
      optionalBoundedStringError(
        payload.historySeed,
        'createOrAttach payload.historySeed',
        DAEMON_PTY_HISTORY_SEED_MAX_BYTES
      ),
    () =>
      optionalBoundedStringError(
        payload.shellOverride,
        'createOrAttach payload.shellOverride',
        DAEMON_PTY_CWD_MAX_BYTES
      ),
    () =>
      optionalNullableBoundedStringError(
        payload.terminalWindowsWslDistro,
        'createOrAttach payload.terminalWindowsWslDistro',
        DAEMON_PTY_CWD_MAX_BYTES
      ),
    () =>
      terminalSizeAdmissionError(payload.cols, payload.rows, 'createOrAttach payload', {
        allowMissing: true
      }),
    () => createEnvironmentError(payload.env),
    () => createEnvironmentDeleteError(payload.envToDelete)
  ]
  for (const check of checks) {
    const error = check()
    if (error) {
      return error
    }
  }
  return null
}

export function daemonHelloAdmissionError(value: unknown): string | null {
  if (!isRecord(value) || value.type !== 'hello') {
    return 'Expected hello'
  }
  if (value.role !== 'control' && value.role !== 'stream') {
    return 'Invalid hello role'
  }
  return boundedStringError(value.clientId, 'hello clientId', DAEMON_CLIENT_ID_MAX_BYTES, {
    nonEmpty: true,
    forbidNull: true
  })
}

export function daemonRequestAdmissionError(value: unknown): string | null {
  if (!isRecord(value)) {
    return 'Daemon request must be an object'
  }
  const idError = boundedStringError(value.id, 'Daemon request id', DAEMON_REQUEST_ID_MAX_BYTES, {
    nonEmpty: true,
    forbidNull: true
  })
  if (idError) {
    return idError
  }
  const typeError = boundedStringError(
    value.type,
    'Daemon request type',
    DAEMON_REQUEST_TYPE_MAX_BYTES,
    { nonEmpty: true }
  )
  if (typeError) {
    return typeError
  }
  if (value.type === 'createOrAttach') {
    return createOrAttachPayloadError(value.payload)
  }
  if (!REQUESTS_WITH_SESSION_ID.has(value.type as string)) {
    return null
  }
  if (!isRecord(value.payload)) {
    return `${value.type as string} payload must be an object`
  }
  const sessionIdError = boundedStringError(
    value.payload.sessionId,
    `${value.type as string} payload.sessionId`,
    DAEMON_SESSION_ID_MAX_BYTES,
    { nonEmpty: true, forbidNull: true }
  )
  if (sessionIdError) {
    return sessionIdError
  }
  return value.type === 'resize'
    ? terminalSizeAdmissionError(value.payload.cols, value.payload.rows, 'resize payload')
    : null
}

export function getBoundedDaemonRequestId(value: unknown): string | null {
  if (!isRecord(value)) {
    return null
  }
  return boundedStringError(value.id, 'Daemon request id', DAEMON_REQUEST_ID_MAX_BYTES, {
    nonEmpty: true,
    forbidNull: true
  }) === null
    ? (value.id as string)
    : null
}
