// Request schemas and response views. Mirrors src/shared/hosted-sandbox/hosted-sandbox-wire.ts on
// the desktop; test/wire-contract.test.ts parses every response with the desktop schemas.
import { z } from 'zod'
import type { OrcadReady } from './sandbox-vm-commands'
import type { SandboxRow } from './store'

const Id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/)

export const CreateRequestSchema = z
  .object({
    workspaceId: Id,
    machineSize: z.enum(['standard', 'large', 'xlarge']),
    region: z
      .string()
      .regex(/^[a-z]{3}[0-9]$/)
      .optional(),
    repo: z
      .object({
        url: z.url({ protocol: /^https$/ }).max(2048),
        ref: z.string().min(1).max(255).optional()
      })
      .strict()
      .optional()
  })
  .strict()

export const LeaseRequestSchema = z
  .object({
    extendMs: z
      .number()
      .int()
      .min(60_000)
      .max(60 * 60_000)
  })
  .strict()

export function sandboxView(row: SandboxRow) {
  const session =
    row.session_id !== null &&
    row.session_started_at !== null &&
    row.session_deadline_at !== null &&
    row.lease_expires_at !== null
      ? {
          id: row.session_id,
          startedAt: row.session_started_at,
          deadlineAt: row.session_deadline_at,
          leaseExpiresAt: row.lease_expires_at
        }
      : null
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    status: row.status,
    machineSize: row.machine_size,
    region: row.region,
    session,
    createdAt: row.created_at
  }
}

export function readyView(row: SandboxRow, connection: OrcadReady) {
  return {
    sandbox: sandboxView(row),
    connection: {
      type: 'orca-server' as const,
      pairingCode: connection.pairingCode,
      projectRoot: connection.projectRoot
    }
  }
}
