import { stringifyJsonWithinByteLimit } from '../shared/node-bounded-json-stringify'
import { MAX_INTEGRATION_CREDENTIAL_FILE_BYTES } from './integration-credential-file'

export const MAX_INTEGRATION_ACCOUNTS = 256
export const MAX_INTEGRATION_ACCOUNT_ID_BYTES = 128
export const MAX_INTEGRATION_ACCOUNT_URL_BYTES = 16 * 1024
export const MAX_INTEGRATION_ACCOUNT_EMAIL_BYTES = 4 * 1024
export const MAX_INTEGRATION_ACCOUNT_LABEL_BYTES = 16 * 1024
export const MAX_INTEGRATION_CREDENTIAL_BYTES = 64 * 1024
export const MAX_INTEGRATION_ACCOUNT_FILE_BYTES = MAX_INTEGRATION_CREDENTIAL_FILE_BYTES

export class IntegrationAccountPersistenceLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IntegrationAccountPersistenceLimitError'
  }
}

export function assertIntegrationAccountCount(service: string, count: number): void {
  if (count > MAX_INTEGRATION_ACCOUNTS) {
    throw new IntegrationAccountPersistenceLimitError(
      `${service} supports at most ${MAX_INTEGRATION_ACCOUNTS} saved accounts.`
    )
  }
}

export function assertIntegrationStringBytes(
  service: string,
  field: string,
  value: string,
  maxBytes: number
): void {
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new IntegrationAccountPersistenceLimitError(
      `${service} ${field} exceeds ${maxBytes} UTF-8 bytes.`
    )
  }
}

export function assertIntegrationCredentialBytes(service: string, value: string): void {
  assertIntegrationStringBytes(service, 'credential', value, MAX_INTEGRATION_CREDENTIAL_BYTES)
}

export function serializeIntegrationAccountFile(value: unknown): string {
  return stringifyJsonWithinByteLimit(value, MAX_INTEGRATION_ACCOUNT_FILE_BYTES, 2).serialized
}

export function unreadableIntegrationAccountFileError(service: string): Error {
  return new Error(
    `Saved ${service} account metadata is unreadable or exceeds supported limits; ` +
      'the existing file was left unchanged.'
  )
}
