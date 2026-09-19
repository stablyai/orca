import type { IPtyProvider } from '../providers/pty-provider-contract'
import { settleOwnershipTransferWrite } from '../providers/pty-ownership-transfer-write-settlement'
import { randomUUID } from 'node:crypto'
import type { OrcaRuntimeWithDelegatedModelClear } from '../runtime/orca-runtime-delegated-model-clear'
import type { connectOrcadDelegatedTransfer } from './orcad-delegated-connection'
import type { PtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'
import { samePtyOwnershipTransferIdentity } from '../../shared/pty-ownership-transfer-identity'
import { bindDelegatedPtyProviderRoute } from '../ipc/pty/provider/delegated-provider-routes'

type Connection = Awaited<ReturnType<typeof connectOrcadDelegatedTransfer>>
type HostProfiles = Pick<IPtyProvider, 'getDefaultShell' | 'getProfiles'>

export function createOrcadDelegatedProviderBinding(
  runtime: Pick<OrcaRuntimeWithDelegatedModelClear, 'clearPublishedDelegatedPtyModel'>,
  getHostProfiles: () => HostProfiles
) {
  return (identity: PtyOwnershipTransferWireIdentity, connection: Connection) =>
    bindOrcadDelegatedPtyProvider(identity, {
      connection,
      getHostProfiles,
      clearBuffer: async (_id, retry) => {
        await runtime.clearPublishedDelegatedPtyModel(
          identity,
          retry?.operationId ?? randomUUID(),
          connection.proof.destinationClaim
        )
        connection.receiver.retryOutput()
      }
    })
}

export function createOrcadDelegatedPtyProvider(options: {
  connection: Connection
  getHostProfiles: () => HostProfiles
  clearBuffer: IPtyProvider['clearBuffer']
}): IPtyProvider {
  const { connection, getHostProfiles, clearBuffer } = options
  const {
    providerInput: input,
    providerControls: controls,
    providerInspection: inspection
  } = connection
  const attachment = connection.providerAttachment
  if (!attachment || !connection.isActive()) {
    throw new Error('orcad_delegated_provider_unavailable')
  }
  const id = connection.proof.terminalId
  const assertActive = (ptyId = id) => {
    if (ptyId !== id || !connection.isActive()) {
      throw new Error('orcad_delegated_provider_unverifiable')
    }
  }
  const unsupported = async (): Promise<never> => {
    throw new Error('orcad_delegated_provider_uses_durable_transfer_recovery')
  }
  return {
    // This is an existing terminal route; fresh spawns remain with the host's spawn provider.
    spawn: unsupported,
    serialize: unsupported,
    revive: unsupported,
    attach: attachment.attach,
    write: input.write,
    writeWithSettlement: (id, data, retry) =>
      settleOwnershipTransferWrite(() => input.writeWithSettlement(id, data, retry)),
    retireWriteOperation: input.retireWriteOperation,
    resize: controls.resize,
    shutdown: controls.shutdown,
    sendSignal: controls.sendSignal,
    clearBuffer: async (ptyId, retry) => {
      assertActive(ptyId)
      await clearBuffer(ptyId, retry)
      assertActive(ptyId)
    },
    getCwd: inspection.getCwd,
    getInitialCwd: inspection.getInitialCwd,
    getAppliedSize: inspection.getAppliedSize,
    hasChildProcesses: inspection.hasChildProcesses,
    getForegroundProcess: inspection.getForegroundProcess,
    listProcesses: inspection.listProcesses,
    getBufferSnapshot: attachment.getBufferSnapshot,
    canProvideAuthoritativeBufferSnapshot: (ptyId) => ptyId === id && connection.isActive(),
    probePtyLiveness: async (ptyId) => {
      assertActive(ptyId)
      try {
        const snapshot = await connection.refreshExecution()
        assertActive(ptyId)
        return snapshot.executionVerdict === 'live'
          ? true
          : snapshot.executionVerdict === 'exited'
            ? false
            : null
      } catch {
        return null
      }
    },
    getDefaultShell: async () => {
      assertActive()
      const shell = await getHostProfiles().getDefaultShell()
      assertActive()
      return shell
    },
    getProfiles: async () => {
      assertActive()
      const profiles = await getHostProfiles().getProfiles()
      assertActive()
      return profiles
    },
    // Runtime model ingress owns output and durable ACKs, independently of renderer credits.
    acknowledgeDataEvent: () => {},
    onData: () => () => {},
    onReplay: () => () => {},
    onExit: connection.onExit
  }
}

export function bindOrcadDelegatedPtyProvider(
  identity: PtyOwnershipTransferWireIdentity,
  options: Parameters<typeof createOrcadDelegatedPtyProvider>[0]
): () => void {
  if (!samePtyOwnershipTransferIdentity(identity, options.connection.proof)) {
    throw new Error('orcad_delegated_provider_identity_mismatch')
  }
  const provider = createOrcadDelegatedPtyProvider(options)
  return bindDelegatedPtyProviderRoute(
    identity,
    options.connection.proof.destinationClaim,
    provider
  )
}
