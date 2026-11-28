// The updater RPCs Edit computer's Orca row and update sheet use; all run on the computer itself.
import * as z from 'zod'
import type {
  RemoteServerUpdateInstallResult,
  RemoteServerUpdateRestartImpact,
  RemoteServerUpdaterSnapshot,
  RemoteServerUpdateSupport
} from '../../../../../src/shared/remote-runtime/host-catalog/remote-server-update'
import type { UpdateStatus } from '../../../../../src/shared/updater/update-status-types'
import { bindDeferredRpcOperation, defineRpcOperation } from '../../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../../transport/rpc/rpc-operation-result-reader'
import type { RpcMethodName } from '../../../../../src/shared/rpc-contract/rpc-params-catalog.generated'

// Only the states the sheet acts on are read closely; any other one reads as idle, so a newer host's
// state never fails the read.
const StatusSchema = z.looseObject({ state: z.string() }).transform((raw, ctx): UpdateStatus => {
  const fields = z
    .looseObject({
      version: z.string().optional().catch(undefined),
      percent: z.number().optional().catch(undefined),
      message: z.string().optional().catch(undefined),
      installing: z.boolean().optional().catch(undefined)
    })
    .safeParse(raw)
  if (!fields.success) {
    ctx.addIssue({ code: 'custom' })
    return z.NEVER
  }
  const { version, percent, message, installing } = fields.data
  switch (raw.state) {
    case 'checking':
      return { state: 'checking' }
    case 'not-available':
      return { state: 'not-available' }
    case 'available':
      return version ? { state: 'available', version, changelog: null } : { state: 'idle' }
    case 'downloading':
      return version ? { state: 'downloading', version, percent: percent ?? 0 } : { state: 'idle' }
    case 'downloaded':
      return version
        ? { state: 'downloaded', version, ...(installing ? { installing } : {}) }
        : { state: 'idle' }
    case 'error':
      return { state: 'error', message: message ?? '' }
    default:
      return { state: 'idle' }
  }
})

// Strings, not enums: a future install mode or reason reads as not automatic.
const SupportSchema = z
  .looseObject({ installMode: z.string(), automatic: z.boolean(), reason: z.string() })
  .transform((support): RemoteServerUpdateSupport => ({
    installMode:
      support.installMode === 'interactive' || support.installMode === 'supervised-headless-serve'
        ? support.installMode
        : 'unsupported-headless-serve',
    automatic: support.automatic,
    reason:
      support.reason === 'available' ||
      support.reason === 'manual-service-update-required' ||
      support.reason === 'unpackaged-build'
        ? support.reason
        : 'updater-unavailable'
  }))

const SnapshotSchema = z
  .looseObject({
    appVersion: z.string(),
    runtimeId: z.string(),
    support: SupportSchema,
    status: StatusSchema
  })
  .transform((snapshot): RemoteServerUpdaterSnapshot => snapshot)

const InstallSchema = z
  .looseObject({
    accepted: z.literal(true),
    fromVersion: z.string(),
    targetVersion: z.string(),
    runtimeId: z.string()
  })
  .transform((install): RemoteServerUpdateInstallResult => install)

const ImpactSchema = z
  .looseObject({
    chats: z.array(
      z.looseObject({
        sessionId: z.string(),
        agent: z.string().nullable().catch(null),
        worktreeId: z.string().nullable().catch(null),
        title: z.string().nullable().catch(null)
      })
    ),
    terminalPtyIds: z.array(z.string())
  })
  .transform((impact): RemoteServerUpdateRestartImpact => impact)

function operation<Method extends RpcMethodName, Value>(method: Method, schema: z.ZodType<Value>) {
  return bindDeferredRpcOperation(
    defineRpcOperation({
      name: method,
      method,
      acceptance: 'require-result-or-throw-message',
      barrier: 'after-caller-barrier',
      read: rpcResultVariant(method, schema)
    })
  )
}

export const updaterStatusRead = operation('updater.getStatus', SnapshotSchema)
export const updaterCheck = operation('updater.check', SnapshotSchema)
export const updaterDownload = operation('updater.download', SnapshotSchema)
export const updaterInstall = operation('updater.install', InstallSchema)
export const updaterRestartImpactRead = operation('updater.restartImpact', ImpactSchema)
