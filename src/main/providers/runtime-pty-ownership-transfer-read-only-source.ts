import { RuntimePtyOwnershipTransferSourceGrants } from './runtime-pty-ownership-transfer-source-grants'
import { join } from 'node:path'
import { RelayPtyOwnershipTransferFileStore } from '../../relay/relay-pty-ownership-transfer-file-store'
import type { PtyOwnershipBridgeCapabilities } from '../../shared/pty-ownership-bridge-contract'
import type {
  PtyOwnershipTransferStatusRequest,
  PtyOwnershipTransferStatusResult
} from '../../shared/pty-ownership-transfer-wire'
import type { PtyOwnershipTransferExitEvent } from '../../shared/pty-ownership-transfer-wire'
import type {
  PtyOwnershipTransferSourceGrant,
  PtyOwnershipTransferSourceGrantRequest
} from '../../shared/pty-ownership-transfer-source-grant'
import type { IPtyProvider } from './pty-provider-contract'
import { applyRuntimePtyOwnershipTransferProviderControl } from './runtime-pty-ownership-transfer-provider-control'
import {
  RuntimePtyOwnershipTransferProviderLifecycle,
  type RuntimePtyProviderReconciliation
} from './runtime-pty-ownership-transfer-provider-lifecycle'
import {
  RuntimePtyOwnershipTransferSourceAdapter,
  type RuntimePtyOwnershipTransferAttachmentBinding,
  type RuntimePtyOwnershipTransferOutputEvent,
  type RuntimePtyOwnershipTransferSourceAdapterOptions
} from './runtime-pty-ownership-transfer-source-adapter'
import { RuntimePtySourceAuthorityFileStore } from './runtime-pty-source-authority-file-store'
import { RuntimePtySourceAuthorityRegistry } from './runtime-pty-source-authority-registry'

type ObservedProvider = Pick<
  IPtyProvider,
  | 'listProcesses'
  | 'onData'
  | 'onExit'
  | 'setInputFenced'
  | 'writeOwnershipTransferInput'
  | 'resize'
  | 'sendSignal'
  | 'clearBuffer'
  | 'shutdown'
  | 'getAppliedSize'
>

export type RuntimePtyOwnershipTransferReadOnlySourceOptions = Readonly<{
  stateDirectory: string
  /** Stable host identity; used to reject self-targeted mutation requests. */
  runtimeId?: string
  onError?: (error: unknown) => void
  /** Test/release-canary gate; omitted keeps this source read-only. */
  mutationEnabled?: () => boolean
  authorizeMutationRequest?: (
    method: string,
    request: unknown,
    binding: RuntimePtyOwnershipTransferAttachmentBinding
  ) => boolean
  applyDestinationControl?: RuntimePtyOwnershipTransferSourceAdapterOptions['applyDestinationControl']
  /** Short-lived grant lifetime; injectable for deterministic expiry tests. */
  grantTtlMs?: number
  /** Clock used for grant expiry; defaults to Date.now. */
  now?: () => number
}>

type ProviderChangeSubscription = (listener: (provider: ObservedProvider) => void) => () => void

/** Production-safe host-local status source; it deliberately exposes no mutation methods. */
export class RuntimePtyOwnershipTransferReadOnlySource {
  private readonly adapter: RuntimePtyOwnershipTransferSourceAdapter
  private readonly lifecycle: RuntimePtyOwnershipTransferProviderLifecycle
  private readonly authorityRegistry: RuntimePtySourceAuthorityRegistry
  private readonly mutationEnabled: () => boolean
  private provider: ObservedProvider | null = null
  private reconciliation: Promise<RuntimePtyProviderReconciliation> | null = null
  private lastReconciliation: RuntimePtyProviderReconciliation | null = null
  private readonly grants: RuntimePtyOwnershipTransferSourceGrants

  constructor(options: RuntimePtyOwnershipTransferReadOnlySourceOptions) {
    this.mutationEnabled = options.mutationEnabled ?? (() => false)
    this.grants = new RuntimePtyOwnershipTransferSourceGrants({
      runtimeId: options.runtimeId,
      grantTtlMs: options.grantTtlMs,
      now: options.now,
      mutationEnabled: () => this.mutationEnabled(),
      sourceAuthority: (terminalId) => this.sourceAuthority(terminalId)
    })
    const paths = runtimePtyOwnershipTransferReadOnlyStatePaths(options.stateDirectory)
    const registry = new RuntimePtySourceAuthorityRegistry({
      store: new RuntimePtySourceAuthorityFileStore(paths.authorityFile)
    })
    this.authorityRegistry = registry
    this.adapter = new RuntimePtyOwnershipTransferSourceAdapter({
      store: new RelayPtyOwnershipTransferFileStore(paths.transferDirectory),
      resolveSource: (terminalId) => registry.resolve(terminalId),
      setInputFenced: (terminalId, fenced) => {
        const setInputFenced = this.provider?.setInputFenced
        if (!setInputFenced) {
          throw new Error('pty_ownership_transfer_runtime_input_fence_unavailable')
        }
        setInputFenced.call(this.provider, terminalId, fenced)
      },
      writeDestinationInput: (terminalId, data) => {
        if (this.provider?.writeOwnershipTransferInput?.(terminalId, data) !== true) {
          throw new Error('pty_ownership_transfer_runtime_source_terminal_unavailable')
        }
      },
      publishDestinationOutput: () => {},
      publishDestinationExit: () => {},
      mutationEnabled: this.mutationEnabled,
      authorizeMutationRequest: options.authorizeMutationRequest,
      applyDestinationControl:
        options.applyDestinationControl ??
        ((identity, control) => {
          const provider = this.provider
          if (!provider) {
            return Promise.resolve('unverifiable' as const)
          }
          return applyRuntimePtyOwnershipTransferProviderControl({
            provider,
            isCurrentProvider: () => this.provider === provider,
            identity,
            control
          })
        })
    })
    this.lifecycle = new RuntimePtyOwnershipTransferProviderLifecycle(registry, this.adapter, {
      onError: options.onError
    })
  }

  /** Installs one exact provider generation before any local status probe is served. */
  reconcileProvider(provider: ObservedProvider): Promise<RuntimePtyProviderReconciliation> {
    if (
      provider === this.provider &&
      this.lastReconciliation?.state === 'current' &&
      !this.reconciliation
    ) {
      return Promise.resolve(this.lastReconciliation)
    }
    if (provider === this.provider && this.reconciliation) {
      return this.reconciliation
    }

    const providerReplaced = this.provider !== null && this.provider !== provider
    this.provider = provider
    if (providerReplaced) {
      // A grant is bound to one provider/socket lifecycle; never let an old
      // paired caller resume against a replacement provider.
      this.grants.clear()
    }
    const pending = this.lifecycle.replaceProvider(provider)
    this.reconciliation = pending
    void pending.then(
      (result) => {
        if (this.provider === provider && this.reconciliation === pending) {
          this.lastReconciliation = result
          this.reconciliation = null
        }
      },
      () => {
        if (this.provider === provider && this.reconciliation === pending) {
          this.lastReconciliation = null
          this.reconciliation = null
        }
      }
    )
    return pending
  }

  getOwnershipBridgeCapabilities(): PtyOwnershipBridgeCapabilities {
    return this.adapter.getCapabilities()
  }

  getOwnershipTransferStatus(
    request: PtyOwnershipTransferStatusRequest
  ): PtyOwnershipTransferStatusResult {
    return this.adapter.status(request)
  }

  /** Authenticate mutations against the exact host incarnation and issued grant. */
  authorizeMutationRequest(
    method: string,
    request: unknown,
    binding: RuntimePtyOwnershipTransferAttachmentBinding
  ): boolean {
    return this.grants.authorizeMutationRequest(method, request, binding)
  }

  /** Returns a source-minted identity only while the exact host incarnation is current. */
  issueOwnershipTransferSourceGrant(
    request: PtyOwnershipTransferSourceGrantRequest,
    binding: RuntimePtyOwnershipTransferAttachmentBinding
  ): PtyOwnershipTransferSourceGrant {
    return this.grants.issueOwnershipTransferSourceGrant(request, binding)
  }

  /** Returns host-minted authority only while this incarnation is proven live. */
  getOwnershipTransferSourceIdentity(terminalId: string) {
    return this.sourceAuthority(terminalId)
  }

  private sourceAuthority(terminalId: string) {
    return this.authorityRegistry.resolve(terminalId)
  }

  /** Internal mutation seam used only by the authenticated paired-runtime RPC bridge. */
  getMutationSource(): RuntimePtyOwnershipTransferSourceAdapter {
    return this.adapter
  }

  onDestinationOutput(
    listener: (event: RuntimePtyOwnershipTransferOutputEvent) => void
  ): () => void {
    return this.adapter.onDestinationOutput(listener)
  }

  onDestinationExit(listener: (event: PtyOwnershipTransferExitEvent) => void): () => void {
    return this.adapter.onDestinationExit(listener)
  }

  dispose(): void {
    this.grants.clear()
    this.provider = null
    this.reconciliation = null
    this.lastReconciliation = null
    this.lifecycle.dispose()
  }
}

export async function startRuntimePtyOwnershipTransferProviderReconciliation(options: {
  source: RuntimePtyOwnershipTransferReadOnlySource
  getProvider: () => ObservedProvider
  subscribe: ProviderChangeSubscription
  onError?: (error: unknown) => void
}): Promise<() => void> {
  const reconcile = (provider: ObservedProvider): void => {
    void options.source.reconcileProvider(provider).catch(options.onError)
  }
  const unsubscribe = options.subscribe(reconcile)
  try {
    await options.source.reconcileProvider(options.getProvider())
    await options.source.reconcileProvider(options.getProvider())
    return unsubscribe
  } catch (error) {
    unsubscribe()
    throw error
  }
}

export async function createReconciledRuntimePtyOwnershipTransferReadOnlySource(
  options: RuntimePtyOwnershipTransferReadOnlySourceOptions & {
    getProvider: () => ObservedProvider
    subscribe: ProviderChangeSubscription
  }
): Promise<
  Readonly<{
    source: RuntimePtyOwnershipTransferReadOnlySource
    unsubscribe: () => void
  }>
> {
  const source = new RuntimePtyOwnershipTransferReadOnlySource(options)
  try {
    const unsubscribe = await startRuntimePtyOwnershipTransferProviderReconciliation({
      source,
      getProvider: options.getProvider,
      subscribe: options.subscribe,
      onError: options.onError
    })
    return Object.freeze({ source, unsubscribe })
  } catch (error) {
    source.dispose()
    throw error
  }
}

export function runtimePtyOwnershipTransferReadOnlyStatePaths(stateDirectory: string): Readonly<{
  authorityFile: string
  transferDirectory: string
}> {
  return Object.freeze({
    authorityFile: join(stateDirectory, 'source-authorities.json'),
    transferDirectory: join(stateDirectory, 'source-transfer-journals')
  })
}
