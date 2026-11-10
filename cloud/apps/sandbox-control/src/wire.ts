// Request schemas and response views. Mirrors src/shared/hosted-sandbox/hosted-sandbox-wire.ts on
// the desktop; test/wire-contract.test.ts parses every response with the desktop schemas.
import { z } from 'zod'
import type { OrcadReady } from './sandbox-vm-commands'
import type { SandboxRow } from './store'
import { MachineSizeInput } from './machine-size'

const Id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/)

export const CreateRequestSchema = z
  .object({
    workspaceId: Id,
    machineSize: MachineSizeInput,
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
      .optional(),
    environmentBuildId: z
      .string()
      .regex(/^bld_[0-9a-f]{8,40}$/)
      .optional(),
    useEnvironment: z.boolean().optional(),
    // Registry metadata (0006); all optional so older desktops keep working.
    title: z.string().trim().min(1).max(120).regex(/^[^\u0000-\u001f]+$/).optional(),
    visibility: z.enum(['private', 'team']).optional(),
    section: z.string().trim().min(1).max(64).regex(/^[^\u0000-\u001f]+$/).optional()
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

/** `archivedAware`: the caller's schema knows `archived`; older strict desktops see `suspended`. */
export function sandboxView(row: SandboxRow, archivedAware = false) {
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
    status: row.status === 'archived' && !archivedAware ? ('suspended' as const) : row.status,
    machineSize: row.machine_size,
    region: row.region,
    session,
    createdAt: row.created_at,
    // Only when set: desktop builds from before environments parse this view strictly.
    ...(row.environment_build_id ? { environmentBuildId: row.environment_build_id } : {})
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

/** `?wait=30s` / `?wait=30000ms` / `?wait=30`, or body `{wait: true}` (= the 30 s max). 0 when absent. */
export function parseWakeWait(url: URL, body: unknown): number {
  const raw = url.searchParams.get('wait')
  if (raw !== null) {
    const match = /^(\d{1,6})(ms|s)?$/.exec(raw.trim())
    if (!match) {
      return 0
    }
    const value = Number(match[1])
    return Math.min(30_000, match[2] === 'ms' ? value : value * 1000)
  }
  const wait = (body as { wait?: unknown } | null)?.wait
  return wait === true ? 30_000 : typeof wait === 'number' && Number.isFinite(wait) ? Math.min(30_000, Math.max(0, wait)) : 0
}
