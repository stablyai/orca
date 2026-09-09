import {
  RESOURCE_RESERVATION_ATTRIBUTION_RUNTIME_CAPABILITY,
  RESOURCE_RESERVATION_ATTRIBUTION_UPDATE_REQUIRED_MESSAGE
} from '../shared/protocol-version'
import type {
  ResourceReservationBinding,
  ResourceReservationKind,
  ResourceReservationRequest
} from '../shared/resource-reservation-binding'
import type { RuntimeStatus } from '../shared/runtime-types'
import { RuntimeClientError } from './runtime-client'
import type { CommandHandler } from './dispatch'

export const RESOURCE_RESERVATION_FLAGS = [
  'idempotency-key',
  'reservation-id',
  'reservation-session',
  'ownership-generation',
  'reservation-issuer'
] as const

const REQUIRED_COMPANION_FLAGS = ['reservation-id', 'reservation-session', 'ownership-generation']

function requireStringFlag(flags: Map<string, string | boolean>, name: string): string {
  const value = flags.get(name)
  if (typeof value !== 'string' || value.length === 0) {
    throw new RuntimeClientError('invalid_argument', `Missing value for --${name}`)
  }
  return value
}

/** Parses the caller-generated reservation binding, or returns undefined when none was passed.
 *  Partial bindings are refused: an unbound create is exactly the ambiguity these flags remove. */
export function getOptionalResourceReservation(
  flags: Map<string, string | boolean>,
  resourceKind: ResourceReservationKind
): ResourceReservationRequest | undefined {
  if (!flags.has('idempotency-key')) {
    const stray = REQUIRED_COMPANION_FLAGS.filter((name) => flags.has(name))
    if (stray.length > 0 || flags.has('reservation-issuer')) {
      throw new RuntimeClientError(
        'invalid_argument',
        `--${stray[0] ?? 'reservation-issuer'} requires --idempotency-key`
      )
    }
    return undefined
  }
  const generationText = requireStringFlag(flags, 'ownership-generation')
  if (!/^\d+$/.test(generationText)) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--ownership-generation must be a non-negative integer'
    )
  }
  const ownershipGeneration = Number(generationText)
  if (!Number.isSafeInteger(ownershipGeneration)) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--ownership-generation must be a safe non-negative integer'
    )
  }
  const issuer = flags.get('reservation-issuer')
  return {
    key: requireStringFlag(flags, 'idempotency-key'),
    reservationId: requireStringFlag(flags, 'reservation-id'),
    sessionId: requireStringFlag(flags, 'reservation-session'),
    resourceKind,
    ownershipGeneration,
    ...(issuer !== undefined ? { issuer: requireStringFlag(flags, 'reservation-issuer') } : {})
  }
}

/** A create response is trustworthy only when the host echoes every immutable request field. */
export function assertResourceReservationEcho(
  requested: ResourceReservationRequest,
  returned: ResourceReservationBinding | undefined,
  resourceLabel: string
): void {
  const matches =
    returned !== undefined &&
    returned.key === requested.key &&
    returned.reservationId === requested.reservationId &&
    returned.sessionId === requested.sessionId &&
    returned.resourceKind === requested.resourceKind &&
    returned.ownershipGeneration === requested.ownershipGeneration &&
    (returned.issuer ?? '') === (requested.issuer ?? '')
  if (!matches) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      `This Orca host returned a mismatched ${resourceLabel} reservation binding, so the resource cannot be attributed. Update Orca on the host.`
    )
  }
}

/** Refuses rather than creating an unattributable resource: an older host drops the unknown
 *  `reservation` param and answers with an ordinary create the caller cannot bind to its ledger. */
export async function assertResourceReservationSupported(
  client: Parameters<CommandHandler>[0]['client']
): Promise<void> {
  const status = await client.call<RuntimeStatus>('status.get', undefined)
  if (!status.result.capabilities?.includes(RESOURCE_RESERVATION_ATTRIBUTION_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      `${RESOURCE_RESERVATION_ATTRIBUTION_UPDATE_REQUIRED_MESSAGE} No resource was created.`
    )
  }
}
