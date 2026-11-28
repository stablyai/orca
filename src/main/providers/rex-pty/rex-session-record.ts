import { randomUUID } from 'node:crypto'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import { z } from 'zod'
const identifier = lazyZodSchema(() => z.uuid())
export const rexLocalPtyId = lazyZodSchema(() =>
  z
    .string()
    .regex(/^(?:[^\0]{1,460}@@)?rex-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
)
export function mintRexPtyId(worktreeId?: string): string {
  const id = `rex-${randomUUID()}`
  return worktreeId ? `${worktreeId}@@${id}` : id
}

export const rexServerIdentity = lazyZodSchema(() =>
  z.object({
    host_id: z.string().min(1).max(256),
    instance_id: z.string().min(1).max(256)
  })
)
export const rexSessionRecord = lazyZodSchema(() =>
  z.strictObject({
    version: z.literal(1),
    backend: z.enum(['rex-local', 'rex-external']),
    id: rexLocalPtyId,
    incarnationId: identifier,
    sessionId: z.string().regex(/^session:[0-9a-f-]{36}$/),
    blockId: z.string().regex(/^block:[0-9a-f-]{36}$/),
    server: rexServerIdentity,
    rootPid: z.number().int().positive(),
    rootIdentity: z
      .object({
        startedAt: z.string().min(1).max(128),
        resolution: z.enum(['clock-tick', 'microsecond', 'second'])
      })
      .optional(),
    interactiveShell: z.boolean().optional(),
    launcherTheme: z
      .object({
        foreground: z.string().regex(/^#[0-9a-f]{6}$/),
        background: z.string().regex(/^#[0-9a-f]{6}$/)
      })
      .optional(),
    cwd: z.string().startsWith('/').max(4096),
    worktreeId: z.string().max(460).optional(),
    paneKey: z.string().max(512).optional(),
    adopted: z.literal(true).optional()
  })
)

export type RexSessionRecord = z.infer<typeof rexSessionRecord>

export function matchesRexServer(
  expected: z.infer<typeof rexServerIdentity>,
  observed: z.infer<typeof rexServerIdentity>
): boolean {
  return expected.host_id === observed.host_id && expected.instance_id === observed.instance_id
}

export function verifyRexIdentity(
  record: RexSessionRecord,
  server: z.infer<typeof rexServerIdentity>,
  pid: number | undefined
): void {
  if (!matchesRexServer(record.server, server)) {
    throw new Error('Rex server identity changed; automatic restore refused')
  }
  if (record.rootPid !== pid) {
    throw new Error('Rex process identity changed; automatic restore refused')
  }
}
