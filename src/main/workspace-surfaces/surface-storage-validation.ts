import type {
  SurfaceStorageRead,
  SurfaceStorageReadResult
} from '../../shared/workspace-surfaces/surface-storage-read'
import { surfaceCommandReceiptSchema } from '../../shared/workspace-surfaces/surface-profile-domain'
import {
  surfaceExecutionProvenanceSchema,
  surfaceExecutorIdentitySchema
} from '../../shared/workspace-surfaces/surface-execution-provenance'
import { z } from 'zod'
import { LayoutApplyParams } from '../../shared/rpc-contract/workspace-layout-params'
import { expectedResumeRecordsSchema } from '../../shared/rpc-contract/workspace-layout-sleep-wake-params'
import { workspaceSessionStateSchema } from '../../shared/workspace-session-schema'
import { sleepingAgentSessionRecordSchema } from '../../shared/workspace-session-sleeping-agents'
import type { LayoutCommand } from '../../shared/workspace-layout/workspace-layout-command-types'
import {
  surfaceAllocationSchema,
  surfaceResourceSchema,
  surfaceRunTargetSchema
} from '../../shared/workspace-surfaces/surface-allocation'
import { surfaceCommandOutcomeSchema } from '../../shared/workspace-surfaces/surface-command'
import {
  surfaceContentSchema,
  workspaceSurfaceSchema
} from '../../shared/workspace-surfaces/surface-schema'
import type {
  SurfaceStorageCommand,
  SurfaceStorageResult
} from '../../shared/workspace-surfaces/surface-storage-command'
import { isRecord } from '../persistence/profile-state/profile-state-document-validation'

const id = z.string().min(1)
const host = { hostId: id }
const identity = { ...host, callerId: id, commandId: id, expiresAt: z.int().nonnegative() }
const expectation = z.object({ occurrence: id, revision: z.int().nonnegative().optional() })
const target = { workspaceId: id, hostTabId: id, expected: expectation.nullable() }
const acknowledgment = z.discriminatedUnion('decision', [
  z.object({
    ...host,
    allocationId: id,
    executorId: id.optional(),
    decision: z.literal('committed'),
    resource: surfaceResourceSchema
  }),
  z.object({
    ...host,
    allocationId: id,
    executorId: id.optional(),
    decision: z.literal('aborting'),
    proof: z.literal('stopped_and_fenced')
  })
])

function isLayoutCommand(value: unknown): value is LayoutCommand {
  if (!isRecord(value)) {
    return false
  }
  if (value.type === 'restartPane' || value.type === 'startPane') {
    return z
      .object({ type: z.enum(['restartPane', 'startPane']), workspace: id, paneKey: id })
      .safeParse(value).success
  }
  if (value.type === 'sleep') {
    return z
      .object({
        type: z.literal('sleep'),
        workspace: id,
        paneKeys: z.array(id).optional(),
        records: z.array(sleepingAgentSessionRecordSchema),
        recordOnly: z.literal(true).optional(),
        expectedRecords: expectedResumeRecordsSchema.optional()
      })
      .safeParse(value).success
  }
  if (value.type === 'wake') {
    return z
      .object({
        type: z.literal('wake'),
        workspace: id,
        paneKeys: z.array(id).optional(),
        recordOnly: z.literal(true).optional(),
        expectedRecords: expectedResumeRecordsSchema.optional()
      })
      .safeParse(value).success
  }
  if (value.type === 'releasePaneTerminal') {
    return z
      .object({
        type: z.literal('releasePaneTerminal'),
        workspace: id,
        tabId: id,
        leafId: id,
        ptyId: id
      })
      .safeParse(value).success
  }
  if (value.type === 'movePaneToNewTab') {
    return z
      .object({
        type: z.literal('movePaneToNewTab'),
        workspace: id,
        tabId: id,
        leafId: id,
        groupId: id.optional(),
        index: z.int().nonnegative().optional(),
        windowDetach: z
          .object({ ptyId: id.nullable(), tabId: id.optional(), startupCwd: id.optional() })
          .optional()
      })
      .safeParse(value).success
  }
  if (value.type === 'setPaneGrid') {
    return z
      .object({
        type: z.literal('setPaneGrid'),
        workspace: id,
        tabId: id,
        leafId: id,
        grid: z.object({ cols: z.int().positive(), rows: z.int().positive() })
      })
      .safeParse(value).success
  }
  return LayoutApplyParams.shape.command.safeParse(value).success
}

const command = z.discriminatedUnion('type', [
  z.object({ ...host, type: z.literal('initialize') }),
  z.object({
    ...host,
    type: z.literal('show-native'),
    sessionId: id,
    hostTabId: id,
    identity: z.object(identity),
    expected: z
      .object({ workspaceId: id, hostTabId: id, occurrence: id, revision: z.int().nonnegative() })
      .nullable()
  }),
  z.object({
    ...host,
    type: z.literal('query'),
    command: z.object({ callerId: id, commandId: id }).optional()
  }),
  z.object({
    ...host,
    type: z.literal('layout'),
    request: z.object({
      ...identity,
      command: z.custom<LayoutCommand>(isLayoutCommand),
      targets: z.array(
        z.object({
          hostTabId: id,
          workspaceId: id.optional(),
          expected: expectation.nullable(),
          leaf: z.object({ leafId: id, occurrence: id, runId: id.optional() }).optional()
        })
      )
    }),
    session: workspaceSessionStateSchema,
    facts: z.object({
      startingLeafIds: z.array(id),
      bindings: z.array(
        z.object({ paneKey: id, ptyId: id, live: z.boolean(), retiring: z.boolean() })
      )
    })
  }),
  z.object({
    ...host,
    type: z.literal('replace'),
    request: z.object({ ...identity, ...target, content: surfaceContentSchema.nullable() })
  }),
  z.object({
    ...host,
    type: z.literal('move'),
    request: z.object({
      ...identity,
      ...target,
      expected: expectation,
      destination: z.object(target)
    })
  }),
  z.object({
    ...host,
    type: z.literal('begin-run'),
    target: surfaceRunTargetSchema,
    resourceId: id,
    executorId: id.optional(),
    provenance: surfaceExecutionProvenanceSchema.nullable().optional()
  }),
  z.object({
    ...host,
    type: z.literal('bind-run'),
    allocationId: id,
    resource: surfaceResourceSchema
  }),
  z.object({ ...host, type: z.literal('abort-run'), allocationId: id }),
  z.object({ ...host, type: z.literal('acknowledge-run'), acknowledgment }),
  z.object({
    ...host,
    type: z.literal('retire-kernel-run'),
    subject: surfaceAllocationSchema,
    observer: surfaceExecutorIdentitySchema
  })
]) satisfies z.ZodType<SurfaceStorageCommand>

const allocationOutcome = z.discriminatedUnion('status', [
  z.object({ status: z.literal('accepted'), allocation: surfaceAllocationSchema }),
  z.object({
    status: z.literal('conflict'),
    code: z.enum(['pane_changed', 'allocation_changed', 'allocation_expired'])
  })
])
const result = z.object({
  hostId: id,
  changes: z
    .object({
      upserted: z.array(workspaceSurfaceSchema),
      removed: z.array(z.object({ hostId: id, workspaceId: id, hostTabId: id })),
      invalidated: z.array(z.object({ hostId: id, workspaceId: id, hostTabId: id })).optional()
    })
    .optional(),
  changedWorkspaces: z.array(id).optional(),
  host: z.object({
    terminalInitialized: z.boolean(),
    chatInitialization: z.enum(['unknown', 'verified']),
    revision: z.int().nonnegative(),
    surfaces: z.array(workspaceSurfaceSchema),
    nativeTabs: z.array(z.object({ tabId: id, sessionId: id })).optional()
  }),
  session: workspaceSessionStateSchema,
  allocations: z.array(surfaceAllocationSchema),
  outcome: z.union([
    surfaceCommandOutcomeSchema,
    allocationOutcome,
    surfaceAllocationSchema,
    z.boolean(),
    z.null()
  ])
}) satisfies z.ZodType<SurfaceStorageResult>

export function isSurfaceStorageCommand(value: unknown): value is SurfaceStorageCommand {
  return command.safeParse(value).success
}

export function isSurfaceStorageResult(value: unknown): value is SurfaceStorageResult {
  return result.safeParse(value).success
}

const storageRead = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run'), hostId: id, target: surfaceRunTargetSchema }),
  z.object({ type: z.literal('receipt'), hostId: id, callerId: id, commandId: id })
])
const storageReadStamp = {
  profileRevision: z.int().nonnegative(),
  rootRevision: z.int().nonnegative(),
  rootHash: z.string().nullable()
}
const storageReadResult = z.discriminatedUnion('type', [
  z.object({
    ...storageReadStamp,
    type: z.literal('run'),
    surface: workspaceSurfaceSchema.nullable(),
    allocation: surfaceAllocationSchema.nullable()
  }),
  z.object({
    ...storageReadStamp,
    type: z.literal('receipt'),
    receipt: surfaceCommandReceiptSchema.nullable()
  })
])
export function isSurfaceStorageRead(value: unknown): value is SurfaceStorageRead {
  return storageRead.safeParse(value).success
}
export function isSurfaceStorageReadResult(value: unknown): value is SurfaceStorageReadResult {
  return storageReadResult.safeParse(value).success
}
