import { z } from 'zod'
import { OrcadManagedStopRequestSchema } from '../../shared/orcad-stop-request'
import {
  ORCAD_INSTALL_MODEL,
  remoteInstallDirName,
  remoteInstallVersionDirRegex
} from './remote-install-model'

export const ORCAD_ACTIVATION_TRANSACTION_SCHEMA_VERSION = 1

const RemoteVersionSchema = z
  .string()
  .refine(
    (version) =>
      remoteInstallVersionDirRegex(ORCAD_INSTALL_MODEL).test(
        remoteInstallDirName(ORCAD_INSTALL_MODEL, version)
      ),
    'Expected a safe remote install version'
  )
const SafeSnapshotNameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9.+-]*$/u)
const SnapshotVerdictSchema = z.object({
  dirName: SafeSnapshotNameSchema,
  state: z.enum(['pending', 'captured', 'empty'])
})
const OrcadActivationTransactionCommonFields = {
  schemaVersion: z.literal(ORCAD_ACTIVATION_TRANSACTION_SCHEMA_VERSION),
  transactionId: z.uuid(),
  startedAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  recordBefore: z.unknown()
}

// Why strict operations: an older client reading a newer operation must keep the fence.
export const OrcadActivationTransactionSchema = z
  .discriminatedUnion('operation', [
    z.object({
      ...OrcadActivationTransactionCommonFields,
      operation: z.literal('activate'),
      phase: z.enum(['prepared', 'incumbent-stopped', 'snapshot-captured', 'candidate-ready']),
      candidateVersion: RemoteVersionSchema,
      recordAfter: z.unknown().nullable(),
      snapshot: SnapshotVerdictSchema
    }),
    z.object({
      ...OrcadActivationTransactionCommonFields,
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
      rescue: SnapshotVerdictSchema
    }),
    z.object({
      ...OrcadActivationTransactionCommonFields,
      operation: z.literal('decommission'),
      phase: z.enum(['prepared', 'stop-dispatched', 'process-exited']),
      activeVersion: RemoteVersionSchema,
      recordAfter: z.unknown(),
      /** The instance-bound stop request; durable before it can reach the host. */
      request: OrcadManagedStopRequestSchema.nullable()
    })
  ])
  .superRefine((transaction, context) => {
    if (transaction.operation === 'decommission') {
      if ((transaction.phase === 'prepared') !== (transaction.request === null)) {
        context.addIssue({ code: 'custom', message: 'Stop request is inconsistent with phase' })
      }
      if (transaction.request && transaction.request.transactionId !== transaction.transactionId) {
        context.addIssue({ code: 'custom', message: 'Stop request names another transaction' })
      }
      return
    }
    const beforeVerdict =
      transaction.phase === 'prepared' || transaction.phase === 'incumbent-stopped'
    const verdict = transaction.operation === 'activate' ? transaction.snapshot : transaction.rescue
    if (beforeVerdict && verdict.state !== 'pending') {
      context.addIssue({ code: 'custom', message: 'Snapshot state advanced before its phase' })
    }
    if (!beforeVerdict && verdict.state === 'pending') {
      context.addIssue({ code: 'custom', message: 'Snapshot phase has no durable verdict' })
    }
    if (
      transaction.operation === 'activate' &&
      (transaction.phase === 'candidate-ready') !== (transaction.recordAfter !== null)
    ) {
      context.addIssue({ code: 'custom', message: 'Committed record is inconsistent with phase' })
    }
  })
