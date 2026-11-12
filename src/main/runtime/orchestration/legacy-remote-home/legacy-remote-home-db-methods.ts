// The DB layer's only way into this folder; keep it free of rpc and runtime imports.
import { attachFederatedDispatchStore } from './federated-dispatch-store'
import type { FederatedDispatchStoreMethods } from './federated-dispatch-store'
import { attachFederatedHomeAutoReleaseStore } from './federated-home-auto-release-store'
import type { FederatedHomeAutoReleaseStoreMethods } from './federated-home-auto-release-store'
import { attachFederatedWorkerStartReconcile } from './federated-worker-start-reconcile'
import type { FederatedWorkerStartReconcileMethods } from './federated-worker-start-reconcile'
import { attachFederationRelayImport } from './federation-relay-import'
import type { FederationRelayImportMethods } from './federation-relay-import'

export type LegacyRemoteHomeDbMethods = FederatedWorkerStartReconcileMethods &
  FederatedDispatchStoreMethods &
  FederationRelayImportMethods &
  FederatedHomeAutoReleaseStoreMethods

export function attachLegacyRemoteHomeDbMethods(ctor: { prototype: object }): void {
  attachFederatedWorkerStartReconcile(ctor)
  attachFederatedDispatchStore(ctor)
  attachFederationRelayImport(ctor)
  attachFederatedHomeAutoReleaseStore(ctor)
}
