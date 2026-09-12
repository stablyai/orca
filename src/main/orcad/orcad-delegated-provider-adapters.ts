import type { OrcadDelegatedConnectionOptions } from './orcad-delegated-connection-contract'
import { OrcadDelegatedProviderInput } from './orcad-delegated-provider-input'
import type { createOrcadDelegatedPtyOperations } from './orcad-delegated-pty-operations'
import { OrcadDelegatedProviderAttachment } from './orcad-delegated-provider-attachment'
import { OrcadDelegatedProviderInspection } from './orcad-delegated-provider-inspection'
import { OrcadDelegatedProviderControls } from './orcad-delegated-provider-controls'

export function createOrcadDelegatedProviderInput(
  options: OrcadDelegatedConnectionOptions,
  operations: ReturnType<typeof createOrcadDelegatedPtyOperations>,
  isActive: () => boolean
) {
  return new OrcadDelegatedProviderInput({
    ptyId: options.identity.terminalId,
    operations,
    readInputs: () => options.store.input.loadDelegated(options.identity),
    isActive,
    onError: options.onError
  })
}

export function createOrcadDelegatedProviderAdapters(
  options: OrcadDelegatedConnectionOptions,
  operations: ReturnType<typeof createOrcadDelegatedPtyOperations>,
  providerInput: OrcadDelegatedProviderInput,
  active: () => boolean
) {
  return {
    providerInput,
    providerAttachment: options.providerModel
      ? new OrcadDelegatedProviderAttachment({
          ptyId: options.identity.terminalId,
          input: providerInput,
          operations,
          isActive: active,
          getSnapshot: options.providerModel.snapshot,
          getModelSequence: options.providerModel.sequence
        })
      : undefined,
    providerInspection: new OrcadDelegatedProviderInspection({
      identity: options.identity,
      workspaceKey: options.adapter.snapshot().surfaceBinding!.workspaceKey,
      input: providerInput,
      operations
    }),
    providerControls: new OrcadDelegatedProviderControls({
      incarnationId: options.identity.incarnationId,
      input: providerInput,
      operations,
      onError: options.onError
    })
  }
}
