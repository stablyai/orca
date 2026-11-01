import { pairedRuntimeConnectionFromOffer } from '../../../shared/paired-runtime-connection'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { z } from 'zod'
import { parsePairingCode, type PairingOffer } from '../../../shared/pairing'
import {
  DELEGATED_MOBILE_DEVICE_SYNC_METHOD,
  DelegatedMobileDeviceSyncParamsSchema
} from '../../../shared/delegated-mobile-device-contract'
import { sendRemoteRuntimeRequest } from '../../../shared/remote-runtime/remote-runtime-client'
import { OrcaRuntimeService } from '../orca-runtime'
import { readRuntimeMetadata } from '../runtime-metadata'
import { OrcaRuntimeRpcServer } from '../runtime-rpc'
import { ORCHESTRATION_CALLER_METHODS } from '../rpc/methods/orchestration/caller-show'
import { STATUS_METHODS } from '../rpc/methods/status'
import { TERMINAL_METHODS } from '../rpc/methods/terminal'
import { BROWSER_CORE_METHODS } from '../rpc/methods/browser-core'
import { BROWSER_SCREENCAST_METHODS } from '../rpc/methods/browser-screencast'
import { SSH_METHODS } from '../rpc/methods/ssh'
import { RUNTIME_CLIENT_CAPABILITY_METHODS } from '../rpc/methods/runtime-client-capabilities'
import { WORKTREE_METHODS } from '../rpc/methods/worktree'
import { CLIENT_UI_METHODS } from '../rpc/methods/client-ui'
import { PAIRING_METHODS } from '../rpc/methods/pairing'
import { FILE_MUTATION_METHODS } from '../rpc/methods/files-mutation-methods'
import { sendRequest } from '../runtime-rpc-test-harness'
import { makeStore } from '../runtime-rpc-worktree-store-fixtures'
import type { MobileDesktopRelayHosts } from './mobile-desktop-relay-hosts'
import { connectRelayTestClient, type RelayTestFrame } from './relay-test-client.test-fixture'

export type Frame = RelayTestFrame

export const WORKTREE = 'id:repo-1::/tmp/worktree-a'
export const TARGET = 'runtime:env-1'

export class SeatObservableRuntime extends OrcaRuntimeService {
  seatClientIds(ptyId: string): string[] {
    return [...(this.mobileSubscribers.get(ptyId)?.keys() ?? [])]
  }
}

export const isOk = (frame: Frame) => frame.ok === true
export const errorCode = (frame: Frame) =>
  z.object({ error: z.object({ code: z.string() }) }).parse(frame).error.code
export const sendAccepted = (frame: Frame) =>
  z.object({ result: z.object({ send: z.object({ accepted: z.boolean() }) }) }).parse(frame).result
    .send.accepted
export const capabilitiesOf = (frame: Frame) =>
  z.object({ result: z.object({ capabilities: z.array(z.string()) }) }).parse(frame).result
    .capabilities

/** Each test file passes its own `cleanups` and drains them in its own afterEach. */
export function createRelayTopology(cleanups: (() => Promise<void> | void)[]) {
  async function startRuntime(spawnedOnThisHost: string[] = [], locator = true) {
    const writes: string[] = []
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture store carries the surface these RPCs read, as in the sibling streaming tests.
    const runtime = new SeatObservableRuntime(makeStore() as never)
    runtime.setPtyController({
      spawn: vi.fn().mockImplementation(async () => {
        spawnedOnThisHost.push('pty-shared')
        return { id: 'pty-shared' }
      }),
      write: (_ptyId, data) => {
        writes.push(data)
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null,
      resize: () => true,
      getSize: () => ({ cols: 80, rows: 24 })
    })
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-relay-'))
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      methods: [
        ...STATUS_METHODS,
        ...(locator ? ORCHESTRATION_CALLER_METHODS : []),
        ...TERMINAL_METHODS,
        ...BROWSER_CORE_METHODS,
        ...BROWSER_SCREENCAST_METHODS,
        ...SSH_METHODS,
        ...RUNTIME_CLIENT_CAPABILITY_METHODS,
        ...CLIENT_UI_METHODS,
        ...WORKTREE_METHODS,
        ...PAIRING_METHODS,
        ...FILE_MUTATION_METHODS
      ],
      enableWebSocket: true,
      wsPort: 0
    })
    await server.start()
    cleanups.push(() => server.stop())
    return { server, runtime, writes, userDataPath }
  }

  function pair(
    server: OrcaRuntimeRpcServer,
    scope: 'mobile' | 'runtime',
    name: string
  ): PairingOffer {
    const offer = server.createPairingOffer({ address: '127.0.0.1', name, scope })
    if (!offer.available) {
      throw new Error('pairing unavailable')
    }
    return parsePairingCode(offer.pairingUrl)!
  }

  async function startTopology(locator = true) {
    const host = await startRuntime([], locator)
    const desktopSpawns: string[] = []
    const desktop = await startRuntime(desktopSpawns)
    const desktopOnHost = pair(host.server, 'runtime', 'MacBook')
    const registry = host.server.getDeviceRegistry()!
    const children = () => registry.listDelegatedMobileDevices(desktopOnHost.pairedDeviceId!)
    const syncedNames: string[][] = []
    const retirementListeners = new Set<(environmentId: string) => void>()
    const state = {
      capable: true,
      hostedPages: new Set<string>(),
      retire: (environmentId: string) =>
        retirementListeners.forEach((listener) => listener(environmentId))
    }
    const hosts: MobileDesktopRelayHosts = {
      list: () => ({
        environments: [],
        statusByEnvironmentId: new Map(),
        sshTargetLabels: new Map(),
        sshConnectionStates: new Map()
      }),
      resolve: async (environmentId) =>
        environmentId === 'env-1'
          ? { environmentId, fence: 'pairing-1', pairing: desktopOnHost }
          : null,
      call: async (_host, method, params) => {
        if (method === DELEGATED_MOBILE_DEVICE_SYNC_METHOD) {
          const { phones } = DelegatedMobileDeviceSyncParamsSchema.parse(params)
          syncedNames.push(phones.map((phone) => phone.name))
        }
        const response = await sendRemoteRuntimeRequest(
          pairedRuntimeConnectionFromOffer(desktopOnHost),
          method,
          params,
          5_000
        )
        return method === 'status.get' && !state.capable && response.ok
          ? {
              ...response,
              result: { ...z.object({}).passthrough().parse(response.result), capabilities: [] }
            }
          : response
      },
      hostsBrowserPage: (environmentId, browserPageId) =>
        environmentId === 'env-1' && state.hostedPages.has(browserPageId),
      onEnvironmentRetired: (listener) => {
        retirementListeners.add(listener)
        return () => retirementListeners.delete(listener)
      },
      onStatusChanged: () => () => {},
      watchChanges: () => ({ close: () => {}, current: () => true })
    }
    desktop.server.setMobileDesktopRelayHosts(hosts)
    const metadata = readRuntimeMetadata(host.userDataPath)!
    const created = await sendRequest(metadata.transports[0]!.endpoint, {
      id: 'create',
      authToken: metadata.authToken,
      method: 'terminal.create',
      params: {
        worktree: WORKTREE,
        command: 'bash',
        tabId: 'tab-1',
        leafId: '11111111-1111-4111-8111-111111111111',
        activate: true
      }
    })
    const handle = z.object({ terminal: z.object({ handle: z.string() }) }).parse(created.result)
      .terminal.handle
    return { host, desktop, desktopSpawns, children, syncedNames, state, handle }
  }

  async function connectPhone(
    desktop: OrcaRuntimeRpcServer,
    name: string,
    scope: 'mobile' | 'runtime' = 'mobile',
    clientCapabilities: readonly string[] = []
  ) {
    const client = await connectRelayTestClient(pair(desktop, scope, name), {
      clientCapabilities,
      defaultExecutionHost: TARGET
    })
    cleanups.push(() => client.close())
    return client
  }

  return { startRuntime, pair, startTopology, connectPhone }
}

export type Phone = Awaited<ReturnType<ReturnType<typeof createRelayTopology>['connectPhone']>>
