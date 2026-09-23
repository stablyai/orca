import { createHash } from 'node:crypto'

export type ProfileStateDocument = {
  domain: string
  payload: string
  domainVersion: number
  revision: number
  updatedAt: number
  contentHash: string
}

export type ProfileStateParsedDocument = Omit<ProfileStateDocument, 'payload'> & { value: unknown }

export class ProfileStateDocumentCorruptionError extends Error {
  readonly code = 'corrupt-document' as const
  readonly domain: string | null

  constructor(message: string, domain: string | null = null) {
    super(message)
    this.name = 'ProfileStateDocumentCorruptionError'
    this.domain = domain
  }
}

export class ProfileStateRevisionConflictError extends Error {
  readonly code = 'profile-state-revision-conflict' as const
  readonly expectedRevision: number
  readonly actualRevision: number

  constructor(expectedRevision: number, actualRevision: number) {
    super(
      `Profile state revision changed while importing a document (expected ${expectedRevision}, found ${actualRevision})`
    )
    this.name = 'ProfileStateRevisionConflictError'
    this.expectedRevision = expectedRevision
    this.actualRevision = actualRevision
  }
}

export function hashProfileStatePayload(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex')
}

export function parseProfileStateRoot(rawJson: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawJson)
  } catch {
    throw new ProfileStateDocumentCorruptionError('Profile state JSON is invalid', null)
  }
  if (!isRecord(parsed)) {
    throw new ProfileStateDocumentCorruptionError('Profile state JSON root must be an object', null)
  }
  return parsed
}

export function validateProfileStateDocumentRow(
  row: unknown,
  options: { validateJson?: boolean; retainParsedValue?: boolean } = {}
): ProfileStateDocument & { value?: unknown } {
  if (
    !isRecord(row) ||
    typeof row.domain !== 'string' ||
    typeof row.payload !== 'string' ||
    typeof row.domain_version !== 'number' ||
    typeof row.revision !== 'number' ||
    typeof row.updated_at !== 'number' ||
    typeof row.content_hash !== 'string'
  ) {
    throw new ProfileStateDocumentCorruptionError('Profile state document row has invalid fields')
  }
  if (
    !Number.isSafeInteger(row.domain_version) ||
    row.domain_version < 1 ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1 ||
    !Number.isSafeInteger(row.updated_at) ||
    row.updated_at < 0 ||
    !/^[a-f0-9]{64}$/.test(row.content_hash)
  ) {
    throw new ProfileStateDocumentCorruptionError(
      `Profile state document row metadata is invalid: ${row.domain}`,
      row.domain
    )
  }
  if (hashProfileStatePayload(row.payload) !== row.content_hash) {
    throw new ProfileStateDocumentCorruptionError(
      `Profile state document hash mismatch: ${row.domain}`,
      row.domain
    )
  }
  let value: unknown
  if (options.retainParsedValue || (options.validateJson ?? true)) {
    try {
      value = JSON.parse(row.payload)
    } catch {
      throw new ProfileStateDocumentCorruptionError(
        `Profile state document payload is invalid JSON: ${row.domain}`,
        row.domain
      )
    }
  }
  return {
    domain: row.domain,
    payload: row.payload,
    domainVersion: row.domain_version,
    revision: row.revision,
    updatedAt: row.updated_at,
    contentHash: row.content_hash,
    ...(options.retainParsedValue ? { value } : {})
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
