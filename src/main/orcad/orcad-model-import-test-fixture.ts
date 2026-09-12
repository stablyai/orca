import { join } from 'node:path'
import {
  identity,
  preparation,
  request,
  makeDelegatedRelay
} from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import { RelayPtyOwnershipTransferFileStore } from '../../relay/relay-pty-ownership-transfer-file-store'
import { PtyOwnershipTransferDestinationFileStore } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-destination-file-store'
import { PtyOwnershipTransferDestinationOutputOutbox } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-destination-output-outbox'
import { digestPtyOwnershipInitialModelSnapshot } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-initial-model-digest'
import { parsePtyOwnershipCaptureBoundary } from '../../shared/pty-ownership-capture-boundary'

export function createOrcadModelImportFixture(directory: string, endpoint = '/registered.sock') {
  const sourceStore = new RelayPtyOwnershipTransferFileStore(join(directory, 'source'))
  const source = makeDelegatedRelay(sourceStore, { enableDestinationOutputRetention: true })
  source.prepare(preparation)
  source.observeOutput(identity.terminalId, 'one🙂')
  const model = {
    version: 1,
    identity,
    throughSeq: 1,
    modelSequenceEnd: 100,
    modelData: 'one🙂',
    cols: 80,
    rows: 24,
    restoreMetadata: { version: 1, pendingEscapeTailAnsi: '\x1b[' }
  }
  const boundary = parsePtyOwnershipCaptureBoundary(
    {
      version: 1,
      identity,
      throughSeq: 1,
      delivery: {
        id: identity.terminalId,
        ptyIncarnation: identity.incarnationId,
        ownerGeneration: identity.sourceOwnerGeneration,
        clientGeneration: 1,
        providerGeneration: 1,
        deliveryToken: 'capture',
        state: 'active',
        windowSu: 1024,
        receivedEndSu: 5,
        sentEndSu: 5,
        creditedEndSu: 5,
        generationClosed: false,
        exitPublished: false
      }
    },
    identity
  )
  const selection = {
    version: 1,
    boundary,
    modelSha256: digestPtyOwnershipInitialModelSnapshot(model, identity, 1)
  }
  source.selectCaptureBaseline(identity, selection, () => boundary)
  const store = new PtyOwnershipTransferDestinationFileStore({
    directory: join(directory, 'destination')
  })
  store.prepare(identity, 1)
  store.bindSurface(identity, preparation.surfacePublication.surfaceBinding)
  store.bindDelegatedSource(identity, {
    version: 1,
    proof: request(),
    endpoint,
    incumbentVersion: 'registered-build',
    endpointCredential: 'registered-credential'
  })
  const outbox = new PtyOwnershipTransferDestinationOutputOutbox({
    directory: join(directory, 'outbox')
  })
  outbox.open(identity, 1)
  const controller = new AbortController()
  const options = {
    runtimeId: identity.destinationRuntimeId,
    identity,
    model,
    store,
    outbox,
    signal: controller.signal
  }
  return { options, model, selection, store, source, sourceStore, outbox, controller }
}
