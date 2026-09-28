import { retainedWslDaemonProtocolVersion } from './wsl-daemon-protocol'
import { WslDaemonOwnerAdmission } from './wsl-daemon-owner-admission'
import { bunOwnedRuntimeArgs } from '../../shared/bun-owned-runtime-args'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import {
  normalizeWslDaemonRecovery,
  sameWslDaemonEndpoint,
  type PersistedWslDaemonEndpoint
} from '../../shared/wsl-daemon-recovery'
import { wslPtyOwnerKey } from '../../shared/wsl-pty-consumer-recovery'
import type { WslPtyOwner } from '../../shared/wsl-pty-id'
import type { Store } from '../persistence'
import { DaemonPtyAdapter } from '../daemon/daemon-pty-adapter'
import { registerWslPtyProvider } from '../ipc/pty/provider/registry'
import { createRunningWslRuntimeRunner } from './wsl-bun-runtime'
import { createWslDaemonTransport } from './wsl-daemon-transport'
import { WslDaemonPtyProvider } from './wsl-daemon-pty-provider'
import { prepareWslDaemonEndpoint, type PreparedWslDaemonEndpoint } from './wsl-daemon-endpoint'
import type { WslAccountExecutionContext } from './wsl-account-execution-context'
import { readWslDistributionIdentity } from './wsl-distribution-identity'

export type WslDaemonConnection = Readonly<{
  owner: Readonly<WslPtyOwner>
  endpoint: Readonly<PersistedWslDaemonEndpoint>
  provider: WslDaemonPtyProvider
}>
export type PreparedWslDaemonTerminalOwner = Readonly<{
  prepared: PreparedWslDaemonEndpoint
  execution: WslAccountExecutionContext
  connection: WslDaemonConnection
}>
type AdmittedConnection = WslDaemonConnection & { establishLease: () => Promise<void> }
type Entry = {
  endpoint: Readonly<PersistedWslDaemonEndpoint>
  pending: Promise<AdmittedConnection>
  close?: () => Promise<void>
}

/** Profile-scoped composition only; the existing daemon owns terminal state and reconnection. */
export class WslDaemonSessions {
  private readonly entries = new Map<string, Entry>()
  private readonly preparing = new Map<string, Promise<PreparedWslDaemonTerminalOwner>>()
  private readonly lifetime = new AbortController()
  private closing: Promise<void> | undefined

  constructor(
    private readonly options: {
      store: Pick<Store, 'getWslDaemonRecovery' | 'upsertWslDaemonRecovery'>
      profileScope: string
      historyRoot: string
    }
  ) {
    if (!options.profileScope || !options.historyRoot) {
      throw new Error('WSL daemon sessions require profile and history scopes')
    }
  }

  prepareFresh(distro: string, signal?: AbortSignal): Promise<PreparedWslDaemonTerminalOwner> {
    signal?.throwIfAborted()
    this.lifetime.signal.throwIfAborted()
    const key = distro.trim().toLowerCase()
    if (!key) {
      throw new Error('WSL terminal distro is required')
    }
    let pending = this.preparing.get(key)
    if (!pending) {
      pending = this.prepare(distro).finally(() => this.preparing.delete(key))
      this.preparing.set(key, pending)
    }
    return waitForPromiseWithSignal(pending, signal)
  }

  private async prepare(distro: string): Promise<PreparedWslDaemonTerminalOwner> {
    const prepared = await prepareWslDaemonEndpoint(
      distro,
      this.options.profileScope,
      this.lifetime.signal
    )
    this.lifetime.signal.throwIfAborted()
    const connection = await this.connect(prepared.owner, prepared.endpoint, undefined, prepared)
    return Object.freeze({
      prepared,
      connection,
      execution: Object.freeze({
        distro: prepared.endpoint.distro,
        userName: prepared.endpoint.userName,
        userId: prepared.endpoint.userId,
        home: prepared.endpoint.home
      })
    })
  }

  reconnect(owner: WslPtyOwner, signal?: AbortSignal): Promise<WslDaemonConnection> {
    signal?.throwIfAborted()
    this.lifetime.signal.throwIfAborted()
    const record = this.options.store.getWslDaemonRecovery(owner)
    if (!record) {
      return Promise.reject(new Error('WSL daemon owner endpoint is unverifiable'))
    }
    const reconnecting = this.connect(owner, record.endpoint).then(async (connection) => {
      this.lifetime.signal.throwIfAborted()
      await connection.establishLease()
      this.lifetime.signal.throwIfAborted()
      return connection
    })
    return waitForPromiseWithSignal(reconnecting, signal)
  }

  private connect(
    owner: WslPtyOwner,
    endpoint: PersistedWslDaemonEndpoint,
    signal?: AbortSignal,
    prepared?: PreparedWslDaemonEndpoint
  ): Promise<AdmittedConnection> {
    this.lifetime.signal.throwIfAborted()
    const identity = Object.freeze({ distro: owner.distro, relayBuildId: owner.relayBuildId })
    const record = normalizeWslDaemonRecovery({ kind: 'daemon', ...identity, endpoint })
    if (!record) {
      return Promise.reject(new Error('WSL daemon owner endpoint is incomplete'))
    }
    const key = wslPtyOwnerKey(owner)
    let entry = this.entries.get(key)
    if (entry && !sameWslDaemonEndpoint(entry.endpoint, record.endpoint)) {
      return Promise.reject(new Error('WSL daemon owner endpoint cannot change'))
    }
    if (!entry) {
      const captured = Object.freeze({ ...record.endpoint })
      const pending = this.open(identity, captured, prepared).catch((error) => {
        this.entries.delete(key)
        throw error
      })
      entry = { endpoint: captured, pending }
      this.entries.set(key, entry)
      return waitForPromiseWithSignal(entry.pending, signal)
    }
    const connection = entry.pending
    return waitForPromiseWithSignal(
      prepared
        ? connection.then(
            async (connected) => {
              await connected.establishLease()
              return connected
            },
            () => {
              this.lifetime.signal.throwIfAborted()
              return this.connect(owner, endpoint, undefined, prepared)
            }
          )
        : connection,
      signal
    )
  }

  private async open(
    owner: Readonly<WslPtyOwner>,
    endpoint: Readonly<PersistedWslDaemonEndpoint>,
    prepared?: PreparedWslDaemonEndpoint
  ): Promise<AdmittedConnection> {
    const signal = this.lifetime.signal
    const protocolVersion = retainedWslDaemonProtocolVersion(endpoint)
    const shell = await readGuestShell(endpoint, signal)
    signal.throwIfAborted()
    const historyId = createHash('sha256')
      .update(JSON.stringify([this.options.profileScope, wslPtyOwnerKey(owner)]))
      .digest('hex')
    const admission = new WslDaemonOwnerAdmission(
      this.options.store,
      owner,
      endpoint,
      signal,
      prepared
    )
    const adapter = new DaemonPtyAdapter({
      respawn: admission.recover,
      protocolVersion,
      profileScope: this.options.profileScope,
      historyPath: join(this.options.historyRoot, historyId),
      guest: {
        distro: owner.distro,
        admitIdentity: admission.admitIdentity,
        transport: createWslDaemonTransport(endpoint),
        defaultShell: shell,
        defaultCwd: endpoint.home,
        profiles: [{ name: shell.slice(shell.lastIndexOf('/') + 1), path: shell }]
      }
    })
    const provider = new WslDaemonPtyProvider(owner, adapter)
    const establishLease = () => admission.establishLease(() => provider.establishLifecycleLease())
    let unregister: (() => void) | undefined
    try {
      await establishLease()
      signal.throwIfAborted()
      unregister = registerWslPtyProvider(owner, provider)
      const entry = this.entries.get(wslPtyOwnerKey(owner))
      if (!entry) {
        throw new Error('WSL daemon session disappeared before publication')
      }
      entry.close = async () => {
        unregister?.()
        await provider.disconnectOnly()
      }
      return Object.freeze({ owner, endpoint, provider, establishLease })
    } catch (error) {
      unregister?.()
      await provider.disconnectOnly()
      throw error
    }
  }

  dispose(): Promise<void> {
    if (!this.closing) {
      this.lifetime.abort(new Error('WSL daemon profile was disposed'))
      const entries = [...this.entries.values()]
      const closing = entries.map(async (entry) => entry.close?.())
      this.closing = (async () => {
        await Promise.all([
          Promise.allSettled([
            ...this.preparing.values(),
            ...entries.map((entry) => entry.pending)
          ]),
          Promise.all(closing)
        ])
        this.entries.clear()
        this.preparing.clear()
      })()
    }
    return this.closing
  }
}

async function readGuestShell(
  endpoint: PersistedWslDaemonEndpoint,
  signal: AbortSignal
): Promise<string> {
  if ((await readWslDistributionIdentity(endpoint.distro)) !== endpoint.distributionId) {
    throw new Error('WSL distribution was replaced; the terminal owner is unverifiable')
  }
  signal.throwIfAborted()
  const runner = createRunningWslRuntimeRunner(endpoint.distro, signal, endpoint.userName)
  const script =
    'const e=JSON.parse(process.argv[1]);if(String(process.getuid())!==e.userId||process.env.HOME!==e.home)throw new Error("WSL terminal owner changed");const s=process.env.SHELL;if(!s||!s.startsWith("/")||/[\\0\\r\\n]/.test(s))throw new Error("WSL login shell unavailable");console.log(s)'
  return runner.run({
    program: endpoint.envBinary,
    args: [
      ...[
        'NODE_OPTIONS',
        'NODE_PATH',
        'BUN_OPTIONS',
        'BUN_INSPECT',
        'ELECTRON_RUN_AS_NODE'
      ].flatMap((key) => ['-u', key]),
      endpoint.runtime,
      ...bunOwnedRuntimeArgs('linux'),
      '-e',
      script,
      JSON.stringify({ userId: endpoint.userId, home: endpoint.home })
    ],
    loginPath: 'preferred'
  })
}
