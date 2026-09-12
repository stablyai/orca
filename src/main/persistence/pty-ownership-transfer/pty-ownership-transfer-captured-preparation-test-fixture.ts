import { vi } from 'vitest'
import { createStore, testState } from '../../persistence-test-harness'
import { createOrcadModelImportFixture } from '../../orcad/orcad-model-import-test-fixture'
import { connectOrcadLocalRelay } from '../../orcad/orcad-local-relay-connection'
import type { SshChannelMultiplexer } from '../../ssh/ssh-channel-multiplexer'
import {
  context,
  identity,
  makeDelegatedRelay
} from '../../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import { PtyOwnershipTransferDestinationRuntimeRegistry } from './pty-ownership-transfer-destination-runtime'
import {
  PtyOwnershipTransferDestinationFileStore,
  ptyOwnershipTransferDestinationDirectory
} from './pty-ownership-transfer-destination-file-store'

export function capturedPreparationFixture(enableDestinationRecovery = false) {
  const fixture = createOrcadModelImportFixture(testState.dir)
  const source = makeDelegatedRelay(fixture.sourceStore, {
    enableDestinationOutputRetention: true,
    enableDestinationOutputRoutes: enableDestinationRecovery,
    enableDestinationDelegationCommit: enableDestinationRecovery,
    resolveTerminalIncarnation: () => identity.incarnationId,
    hasPendingSourceOutput: () => false,
    enableCaptureImportAcknowledgement: true
  })
  source.observeOutput(identity.terminalId, 'later')
  const rpc = vi.fn<SshChannelMultiplexer['request']>(async (_method, params) =>
    source.inspectDestination(params, context())
  )
  vi.mocked(connectOrcadLocalRelay).mockImplementation(async (options) => {
    const connection = {
      request: rpc,
      dispose: vi.fn(),
      onDispose: () => () => {}
    } as unknown as SshChannelMultiplexer
    options.initialize(connection)
    return connection
  })
  const store = createStore()
  const reopen = (catalogStore = createStore(), catalogPublicationVersion?: 1) =>
    new PtyOwnershipTransferDestinationRuntimeRegistry({
      runtimeId: identity.destinationRuntimeId,
      catalogPublicationVersion,
      store: catalogStore,
      publishPostCommitOutput: vi.fn(),
      publishPostCommitOutputAcknowledged: (identity, _binding, frame) => ({
        identity,
        throughSeq: frame.seq
      })
    })
  const registry = reopen(store)
  const destinationStore = new PtyOwnershipTransferDestinationFileStore({
    directory: ptyOwnershipTransferDestinationDirectory(store.getProfileStorageDirectory())
  })
  const input = {
    identity,
    source: fixture.store.loadDelegatedSource(identity),
    model: fixture.model,
    signal: fixture.controller.signal
  }
  return { ...fixture, source, rpc, store, registry, destinationStore, input, reopen }
}
