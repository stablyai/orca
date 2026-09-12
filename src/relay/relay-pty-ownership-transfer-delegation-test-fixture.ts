import { createHash, randomBytes } from 'node:crypto'
import type { RequestContext } from './dispatcher'
import {
  RelayPtyOwnershipTransferAdapter,
  type RelayPtyOwnershipTransferAdapterOptions
} from './relay-pty-ownership-transfer-adapter'
import type { RelayPtyOwnershipTransferStore } from './relay-pty-ownership-transfer-adapter-contract'

export const credential = randomBytes(32).toString('hex')
export const source = {
  terminalId: 'pty-1',
  incarnationId: 'incarnation-1',
  ownerLease: 'desktop-lease',
  sourceOwnerGeneration: 8
}
export const identity = { ...source, bridgeId: 'bridge-1', destinationRuntimeId: 'host-orcad' }
export const preparation = {
  version: 1 as const,
  ...identity,
  destinationDelegation: {
    version: 1 as const,
    credentialSha256: createHash('sha256').update(credential).digest('hex')
  },
  surfacePublication: {
    version: 1 as const,
    surfaceBinding: {
      executionHostId: 'local' as const,
      workspaceKey: 'folder:folder-1' as const,
      tabId: 'tab-1',
      leafId: '11111111-1111-4111-8111-111111111111',
      ptyId: 'pty-1'
    }
  }
}
export const request = (generation = 1) => ({
  version: 1 as const,
  ...identity,
  credential,
  previousDestinationGeneration: generation - 1,
  destinationGeneration: generation,
  claimId: `claim-${generation}`
})
export const context = (clientId = 2, transportGeneration = 1): RequestContext => ({
  clientId,
  transportGeneration,
  isStale: () => false,
  sessionIdentity: {
    principal: 'host-local-principal',
    authenticated: true,
    allowSessionOwner: false,
    authenticationKind: 'endpoint-credential'
  }
})

export function makeDelegatedRelay(
  store: RelayPtyOwnershipTransferStore,
  patch: Partial<RelayPtyOwnershipTransferAdapterOptions> = {}
) {
  return new RelayPtyOwnershipTransferAdapter({
    store,
    enableDestinationDelegationPreparation: true,
    enableDestinationDelegationClaims: true,
    resolveSource: () => source,
    authorizeRequest: () => false,
    setInputFenced: () => {},
    writeDestinationInput: () => {},
    publishDestinationOutput: () => {},
    ...patch
  })
}
