import { mkdtempSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { z } from 'zod'
import { pairedRuntimeConnectionFromOffer } from '../../../shared/remote-runtime/pairing/paired-runtime-connection'
import {
  DELEGATED_MOBILE_DEVICE_SYNC_METHOD,
  DelegatedMobileDeviceSyncParamsSchema
} from '../../../shared/delegated-mobile-device-contract'
import { sendRemoteRuntimeRequest } from '../../../shared/remote-runtime/remote-runtime-client'
import { publishHostDescriptor } from '../hosts/platform-probe/host-descriptor'
import { OrcaRuntimeService } from '../orca-runtime'
import { readRuntimeMetadata } from '../rpc/server/runtime-metadata'
import { OrcaRuntimeRpcServer } from '../rpc/server/runtime-rpc'
import { ORCHESTRATION_CALLER_METHODS } from '../rpc/methods/orchestration/caller-show'
import { STATUS_METHODS } from '../rpc/methods/host-management/status'
import { TERMINAL_METHODS } from '../rpc/methods/terminal/terminal'
import { BROWSER_CORE_METHODS } from '../rpc/methods/browser/browser-core'
import { BROWSER_SCREENCAST_METHODS } from '../rpc/methods/browser/browser-screencast'
import { SSH_METHODS } from '../rpc/methods/ssh/ssh'
import { RUNTIME_CLIENT_CAPABILITY_METHODS } from '../rpc/methods/client-events/runtime-client-capabilities'
import { WORKTREE_METHODS } from '../rpc/methods/workspaces/worktree'
import { CLIENT_UI_METHODS } from '../rpc/methods/client-state/client-ui'
import { PAIRING_METHODS } from '../rpc/methods/pairing/pairing'
import { GITHUB_ISSUE_METHODS } from '../rpc/methods/source-control/github/github-issue-methods'
import { GITHUB_REPO_WORK_ITEM_METHODS } from '../rpc/methods/source-control/github/github-repo-work-item-methods'
import { FILE_MUTATION_METHODS } from '../rpc/methods/files/files-mutation-methods'
import { sendRequest } from '../rpc/server/runtime-rpc-test-harness'
import { makeStore } from '../rpc/server/runtime-rpc-worktree-store-fixtures'
import type { MobileDesktopRelayHosts } from './mobile-desktop-relay-hosts'
import { pair } from './mobile-desktop-relay-phone.test-fixture'

class SeatObservableRuntime extends OrcaRuntimeService {
  seatClientIds(ptyId: string): string[] {
    return [...(this.mobileSubscribers.get(ptyId)?.keys() ?? [])]
  }
}

export const WORKTREE = 'id:repo-1::/tmp/worktree-a'

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
        ...GITHUB_ISSUE_METHODS,
        ...GITHUB_REPO_WORK_ITEM_METHODS,
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
    publishHostDescriptor(runtime.getRuntimeId(), { installationId: randomUUID() })
    cleanups.push(() => publishHostDescriptor(runtime.getRuntimeId(), null))
    cleanups.push(() => server.stop())
    return { server, runtime, writes, userDataPath }
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
      pairing: desktopOnHost,
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
          ? { environmentId, fence: state.pairing.endpoint, pairing: state.pairing }
          : null,
      call: async (_host, method, params) => {
        if (method === DELEGATED_MOBILE_DEVICE_SYNC_METHOD) {
          const { phones } = DelegatedMobileDeviceSyncParamsSchema.parse(params)
          syncedNames.push(phones.map((phone) => phone.name))
        }
        const response = await sendRemoteRuntimeRequest(
          pairedRuntimeConnectionFromOffer(state.pairing),
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

  return { startRuntime, startTopology }
}
