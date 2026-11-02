import { Hono } from 'hono'
import { z } from 'zod'
import type { RelayFenceBrokerConfig } from './config.js'
import {
  GoogleStorageMutationLease,
  MutationLeaseConflict
} from './mutation-lease.js'
import {
  runSourceFence,
  runTargetSupersession
} from './fence-operation-runner.js'

const expectedLeaseSchema = z
  .object({
    generation: z.string().regex(/^[1-9][0-9]{0,30}$/),
    operationId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict()

const supersessionRequestSchema = z.object({
  v: z.literal(1),
  operationId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
  fenceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  completedFenceRecovery: z
    .object({
      attemptId: z.string().uuid(),
      fenceCommit: z.string().regex(/^[a-f0-9]{40}$/),
      gceOperation: z.string().min(1).max(256),
      terraformStateSerial: z.number().int().nonnegative().safe(),
      planObjectGeneration: z.string().regex(/^[1-9][0-9]{0,30}$/),
      terraformStateObjectGeneration: z.string().regex(/^[1-9][0-9]{0,30}$/),
      terraformStateObjectSha256: z.string().regex(/^[a-f0-9]{64}$/)
    })
    .strict()
    .optional(),
  expectedLease: expectedLeaseSchema.optional(),
  confirmation: z.literal('SUPERSEDE_TARGET')
})
  .strict()
  .refine(
    (value) =>
      (!value.completedFenceRecovery || Boolean(value.expectedLease)) &&
      (!value.expectedLease || value.expectedLease.operationId === value.operationId)
  )

const cellIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,127}$/)
const sourceFenceRequestSchema = z
  .object({
    v: z.literal(1),
    operationId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
    fenceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    targetCellIds: z.array(cellIdSchema).min(1).max(16),
    expectedLease: expectedLeaseSchema.optional(),
    confirmation: z.literal('FENCE_SOURCE')
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.targetCellIds).size === value.targetCellIds.length &&
      (!value.expectedLease || value.expectedLease.operationId === value.operationId)
  )

type AppDependencies = {
  lease?: GoogleStorageMutationLease
  supersede?: (
    config: RelayFenceBrokerConfig,
    recovery?: z.infer<typeof supersessionRequestSchema>['completedFenceRecovery']
  ) => Promise<void>
  fenceSource?: (
    config: RelayFenceBrokerConfig,
    targetCellIds: string[]
  ) => Promise<void>
}

export function createApp(
  config: RelayFenceBrokerConfig,
  dependencies: AppDependencies = {}
): Hono {
  const app = new Hono()
  const lease =
    dependencies.lease ??
    new GoogleStorageMutationLease(
      config.stateBucket,
      config.leaseObject,
      config.imageCommit
    )
  const supersede = dependencies.supersede ?? runTargetSupersession
  const fenceSource = dependencies.fenceSource ?? runSourceFence

  app.get('/healthz', (context) =>
    context.json({ ok: true, fenceCommit: config.imageCommit })
  )
  app.post('/v1/supersede-target', async (context) => {
    const parsed = supersessionRequestSchema.safeParse(
      await context.req.json().catch(() => null)
    )
    if (!parsed.success) return context.json({ error: 'invalid_request' }, 400)
    if (parsed.data.fenceCommit !== config.imageCommit) {
      return context.json({ error: 'fence_commit_mismatch' }, 409)
    }
    let acquired
    try {
      acquired = await lease.acquire(
        parsed.data.operationId,
        parsed.data,
        parsed.data.expectedLease
      )
    } catch (error) {
      if (error instanceof MutationLeaseConflict) {
        return context.json({ error: 'mutation_lease_conflict' }, 409)
      }
      throw error
    }
    await supersede(config, parsed.data.completedFenceRecovery)
    await lease.release(acquired)
    return context.json({
      ok: true,
      operationId: parsed.data.operationId,
      fenceCommit: config.imageCommit
    })
  })
  app.post('/v1/fence-source', async (context) => {
    const parsed = sourceFenceRequestSchema.safeParse(
      await context.req.json().catch(() => null)
    )
    if (
      !parsed.success ||
      parsed.data.targetCellIds.includes(config.sourceCellId)
    ) {
      return context.json({ error: 'invalid_request' }, 400)
    }
    if (parsed.data.fenceCommit !== config.imageCommit) {
      return context.json({ error: 'fence_commit_mismatch' }, 409)
    }
    let acquired
    try {
      acquired = await lease.acquire(
        parsed.data.operationId,
        parsed.data,
        parsed.data.expectedLease
      )
    } catch (error) {
      if (error instanceof MutationLeaseConflict) {
        return context.json({ error: 'mutation_lease_conflict' }, 409)
      }
      throw error
    }
    await fenceSource(config, parsed.data.targetCellIds)
    await lease.release(acquired)
    return context.json({
      ok: true,
      operationId: parsed.data.operationId,
      fenceCommit: config.imageCommit
    })
  })
  app.onError((error, context) => {
    console.error(error)
    return context.json({ error: 'broker_operation_failed' }, 500)
  })
  return app
}
