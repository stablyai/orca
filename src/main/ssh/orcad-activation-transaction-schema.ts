import { z } from 'zod'
import { isRemoteInstallVersion } from './remote-install-model'
import { OrcadManagedStopAuthoritySchema } from '../../shared/orcad-managed-stop-authority'
import { OrcadManagedStopInstanceSchema } from '../../shared/orcad-managed-stop-instance'

export const ORCAD_ACTIVATION_TRANSACTION_SCHEMA_VERSION = 1

const RemoteVersionSchema = z
  .string()
  .refine(isRemoteInstallVersion, 'Expected a safe remote install version')
const SafeSnapshotNameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9.+-]*$/u)
const TransactionBaseShape = {
  schemaVersion: z.literal(ORCAD_ACTIVATION_TRANSACTION_SCHEMA_VERSION),
  transactionId: z.uuid(),
  startedAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  recordBefore: z.unknown()
}

export const OrcadActivationTransactionSchema = z
  .discriminatedUnion('operation', [
    z.object({
      ...TransactionBaseShape,
      operation: z.literal('activate'),
      phase: z.enum(['prepared', 'incumbent-stopped', 'snapshot-captured', 'candidate-ready']),
      candidateVersion: RemoteVersionSchema,
      recordAfter: z.unknown().nullable(),
      snapshot: z.object({
        dirName: SafeSnapshotNameSchema,
        state: z.enum(['pending', 'captured', 'empty'])
      })
    }),
    z.object({
      ...TransactionBaseShape,
      operation: z.literal('rollback'),
      phase: z.enum([
        'prepared',
        'incumbent-stopped',
        'rescue-captured',
        'rollback-state-restored',
        'target-ready'
      ]),
      incumbentVersion: RemoteVersionSchema,
      targetVersion: RemoteVersionSchema,
      recordAfter: z.unknown(),
      rescue: z.object({
        dirName: SafeSnapshotNameSchema,
        state: z.enum(['pending', 'captured', 'empty'])
      })
    }),
    z.object({
      ...TransactionBaseShape,
      schemaVersion: z.union([z.literal(1), z.literal(2)]),
      authority: OrcadManagedStopAuthoritySchema.optional(),
      instance: OrcadManagedStopInstanceSchema.optional(),
      operation: z.literal('decommission'),
      phase: z.enum(['prepared', 'admission-fenced', 'process-exited']),
      activeVersion: RemoteVersionSchema,
      acceptedRecord: z.unknown(),
      recordAfter: z.unknown()
    })
  ])
  .superRefine((transaction, context) => {
    if (transaction.operation === 'decommission') {
      if (transaction.instance && (transaction.schemaVersion !== 2 || !transaction.authority)) {
        context.addIssue({
          code: 'custom',
          message: 'Managed stop instance requires schema version 2 and authority'
        })
      }
      if ((transaction.schemaVersion === 2) !== (transaction.authority !== undefined)) {
        context.addIssue({
          code: 'custom',
          message: 'Managed stop authority requires schema version 2'
        })
      }
      if (
        transaction.authority &&
        transaction.authority.transactionId !== transaction.transactionId
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Managed stop authority transaction ID mismatch'
        })
      }
      return
    }
    if (transaction.operation === 'activate') {
      const beforeSnapshot =
        transaction.phase === 'prepared' || transaction.phase === 'incumbent-stopped'
      if (beforeSnapshot && transaction.snapshot.state !== 'pending') {
        context.addIssue({ code: 'custom', message: 'Snapshot state advanced before its phase' })
      }
      if (!beforeSnapshot && transaction.snapshot.state === 'pending') {
        context.addIssue({ code: 'custom', message: 'Snapshot phase has no durable verdict' })
      }
      if ((transaction.phase === 'candidate-ready') !== (transaction.recordAfter !== null)) {
        context.addIssue({ code: 'custom', message: 'Committed record is inconsistent with phase' })
      }
      return
    }
    if (transaction.operation === 'rollback') {
      const beforeRescue =
        transaction.phase === 'prepared' || transaction.phase === 'incumbent-stopped'
      if (beforeRescue && transaction.rescue.state !== 'pending') {
        context.addIssue({ code: 'custom', message: 'Rescue state advanced before its phase' })
      }
      if (!beforeRescue && transaction.rescue.state === 'pending') {
        context.addIssue({
          code: 'custom',
          message: 'Rollback phase has no durable rescue verdict'
        })
      }
    }
  })
