import {
  RecoveryWorkspaceRuntime,
  type RecoveryRuntimeObservation
} from './client-page-recovery-workspace-test-harness'
import { BROWSER_CLIENT_AUTOMATION_HOST_CAPABILITY } from '../../../../shared/browser/client-hosting/browser-client-automation-protocol'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-session-contracts'
import { createProfile } from './client-hosted-browser-persistence-test-harness'
import { RpcDispatcher } from '../../rpc/dispatcher'
import { BROWSER_CLIENT_HOST_METHODS } from '../../rpc/methods/browser/browser-client-host'
import { BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY } from '../../../../shared/browser/runtime/browser-runtime-capabilities'
import {
  BROWSER_CLIENT_PAGE_INITIALIZATION_CAPABILITY,
  type BrowserClientHostCommandEvent,
  type BrowserClientHostedPageInventory
} from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import { BrowserClientHostCommandDispatcher } from '../../../browser/client-hosts/commands/browser-client-host-command-dispatcher'
import type { BrowserClientPageCommandExecutor } from '../../../browser/client-pages/execution/browser-client-page-command-executor'
import {
  createRecoveryNativeLoop,
  seedRecoveryNativePages
} from './client-page-recovery-native-test-harness'
import { getRuntimeBrowserPageRegistry } from './runtime-browser-page-registry'
import { getBrowserHostLeaseRegistry } from '../../browser-host/leases/browser-host-lease-registry-instance'
import { RESTORED_CLIENT_HOSTED_BROWSER_PLACEMENT } from './client-hosted-browser-page-persistence'

export function createRecoveryLoop(
  ids: readonly string[],
  loopOptions: {
    worktreeCount?: number
    maxCachedCommandResults?: number
    maxConcurrentHandlers?: number
    nativeLoop?: ReturnType<typeof createRecoveryNativeLoop>
    executor?: BrowserClientPageCommandExecutor
  } = {}
) {
  const cleanups = new Map<string, () => void>()
  const publications = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>()
  const hooks: {
    onResult?: (event: BrowserClientHostCommandEvent) => void
    beforeResult?: (event: BrowserClientHostCommandEvent) => Promise<void>
    onNotify?: () => void
    beforeWorkspace?: () => Promise<void>
    failCommit?: boolean
    delivery?: (event: BrowserClientHostCommandEvent, dispatch: () => void) => void
  } = {}
  const nativeLoop = loopOptions.nativeLoop ?? createRecoveryNativeLoop(hooks)
  const { native } = nativeLoop
  const commands: BrowserClientHostCommandEvent[] = []
  const results: { type: string; id: string; status: string }[] = []
  const snapshots: { reconciled: boolean; ids: string[] }[] = []
  const errors: unknown[] = []
  const streams: Promise<void>[] = []
  let reconciled = false
  let connectionId = ''
  let browserHostClientId = 'client-a'
  let executor: BrowserClientPageCommandExecutor
  let client: BrowserClientHostCommandDispatcher | undefined
  let authorityGeneration = 0
  const profile = createProfile(loopOptions.worktreeCount)
  class RecoveryRuntime extends RecoveryWorkspaceRuntime {
    projectedFrames = 0
    sessionTabsSequence() {
      return this.mobileSessionTabsChangeSequence
    }
    protected override projectMobileSessionTabsForClient(
      result: RuntimeMobileSessionTabsResult,
      clientId?: string
    ) {
      this.projectedFrames += 1
      return super.projectMobileSessionTabsForClient(result, clientId)
    }
    peekSnapshotForClient(worktree: string, clientId: string) {
      return this.getMobileSessionTabsForWorktree(worktree, clientId, {
        includeAgentSenders: false
      })
    }
    async snapshotForClient(worktree: string, clientId: string) {
      const result = await this.getMobileSessionTabsForWorktree(worktree, clientId, {
        includeAgentSenders: false
      })
      this.observeClientHostedPageSnapshots([result], clientId)
      return result
    }
    override async markClientHostedPagesReconciled(id: string): Promise<void> {
      await super.markClientHostedPagesReconciled(id)
      reconciled = true
      notify()
    }
    override notifyMobileSessionTabsChanged(id?: string): void {
      super.notifyMobileSessionTabsChanged(id)
      notify()
    }
  }
  const hostRuntime: RecoveryRuntimeObservation = Object.assign(
    new RecoveryRuntime(profile.store, undefined, {}),
    { beforeRecoveryWorkspace: () => hooks.beforeWorkspace?.() }
  )
  const registerSubscription = hostRuntime.registerSubscriptionCleanup.bind(hostRuntime)
  hostRuntime.registerSubscriptionCleanup = (id, cleanup, connection) => {
    registerSubscription(id, cleanup, connection)
    cleanups.set(connection ?? '', () => hostRuntime.cleanupSubscription(id))
  }
  const pages = getRuntimeBrowserPageRegistry(hostRuntime)
  const authority = getBrowserHostLeaseRegistry(hostRuntime)
  const rpc = new RpcDispatcher({ runtime: hostRuntime, methods: BROWSER_CLIENT_HOST_METHODS })
  function notify() {
    hooks.onNotify?.()
    snapshots.push({ reconciled, ids: pages.listPages().map((page) => page.browserPageId) })
    for (const [id, done] of publications) {
      if (pages.getPage(id)?.placement.pageHostGeneration) {
        done.resolve()
      }
    }
  }
  executor = loopOptions.executor ?? nativeLoop.createExecutor()
  for (const id of ids) {
    pages.publishClientPage({
      browserPageId: id,
      workspaceId: 'repo-1::/tmp/worktree-a',
      browserProfileId: 'profile-a',
      executionHostKey: 'old-key',
      placement: RESTORED_CLIENT_HOSTED_BROWSER_PLACEMENT,
      pairedDeviceId: 'device-a',
      url: `https://example.internal/${id}`,
      loading: false,
      active: false
    })
  }
  const caller = () => ({
    connectionId,
    clientKind: 'runtime' as const,
    pairedDeviceId: 'device-a',
    clientCapabilities: [BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY]
  })
  function attach(
    options: {
      inventory?: readonly BrowserClientHostedPageInventory[]
      hostId?: string
      modern?: boolean
      omitInventory?: boolean
    } = {}
  ) {
    connectionId = `connection-${++authorityGeneration}`
    browserHostClientId = options.hostId ?? browserHostClientId
    const attachedConnection = connectionId
    const stopped = new AbortController()
    const completion = rpc.dispatchStreaming(
      {
        id: attachedConnection,
        authToken: 'test',
        method: 'browser.clientHost.attach',
        params: {
          authorityRuntimeId: 'runtime-a',
          browserHostClientId,
          hostCapabilities: [
            'webview',
            BROWSER_CLIENT_AUTOMATION_HOST_CAPABILITY,
            ...(options.modern === false ? [] : [BROWSER_CLIENT_PAGE_INITIALIZATION_CAPABILITY])
          ],
          pageCommandProtocolVersion: 1,
          ...(!options.omitInventory
            ? {
                pageReconciliationProtocolVersion: 1,
                pageInventoryProtocolVersion: 1,
                pageInventory: options.inventory ?? executor.snapshotPageInventory(),
                leaseReconnectProtocolVersion: 1
              }
            : {})
        }
      },
      (reply) => {
        const message = JSON.parse(reply)
        if (message.ok === false) {
          errors.push(message.error)
          return
        }
        const event = message.result
        if (event?.type === 'ready') {
          if (!client || clientGeneration !== event.browserHostGeneration) {
            clientGeneration = event.browserHostGeneration
            client = new BrowserClientHostCommandDispatcher({
              maxCachedCommandResults: loopOptions.maxCachedCommandResults,
              maxConcurrentHandlers: loopOptions.maxConcurrentHandlers,
              authority: { ...event, authorityRuntimeId: 'runtime-a', browserHostClientId },
              handler: (command, signal, close) => executor.handle(command, signal, close),
              acquireInitialization: (command) => executor.acquireInitialization(command)
            })
          }
          return
        }
        if (event?.type !== 'command') {
          return
        }
        commands.push(event)
        const dispatch = () => {
          void client!
            .dispatch(event)
            .then(async (result) => {
              if (hooks.beforeResult) {
                await hooks.beforeResult(event)
              }
              hooks.onResult?.(event)
              results.push({
                type: event.command.type,
                id: event.browserPageId,
                status: result.status
              })
              await rpc.dispatchStreaming(
                {
                  id: `result-${event.commandId}`,
                  authToken: 'test',
                  method: 'browser.clientHost.commandResult',
                  params: { ...event, result }
                },
                () => {},
                caller()
              )
            })
            .catch((error) => errors.push(error))
        }
        if (hooks.delivery) {
          hooks.delivery(event, dispatch)
        } else {
          dispatch()
        }
      },
      { ...caller(), signal: stopped.signal }
    )
    streams.push(completion)
    return {
      completion,
      abort: () => stopped.abort(),
      disconnect: () => cleanups.get(attachedConnection)?.()
    }
  }
  let clientGeneration = 0
  return {
    pages,
    hooks,
    profile,
    authority,
    commands,
    results,
    snapshots,
    errors,
    native,
    nativeLoop,
    hostRuntime,
    rpc,
    caller,
    attach,
    hold: nativeLoop.hold,
    release: nativeLoop.release,
    holdMount: nativeLoop.holdMount,
    holdRetirement: nativeLoop.holdRetirement,
    seedNative: (ids: readonly string[], profileId?: string, controlled?: boolean) =>
      seedRecoveryNativePages(executor, ids, browserHostClientId, profileId, controlled),
    get executor() {
      return executor
    },
    published(id: string) {
      if (pages.getPage(id)?.placement.pageHostGeneration) {
        return Promise.resolve()
      }
      const done = publications.get(id) ?? Promise.withResolvers<void>()
      publications.set(id, done)
      return done.promise
    },
    fence() {
      const current = authority.select(browserHostClientId)
      const replacement = authority.attach({
        browserHostClientId,
        pairedDeviceId: 'device-a',
        connectionId: 'full-fence',
        hostCapabilities: [...current.hostCapabilities, 'fence-test'],
        pageCommandProtocolVersion: 1,
        pageInventoryProtocolVersion: 1,
        pageInventory: [],
        pageReconciliationProtocolVersion: 1,
        leaseReconnectProtocolVersion: 1
      })
      replacement.release()
    },
    closeClientDispatcher: () => client?.close(),
    async restartClient() {
      await client?.close()
      await executor.close()
      client = undefined
      executor = nativeLoop.createExecutor()
    },
    async close() {
      for (const cleanup of cleanups.values()) {
        cleanup()
      }
      nativeLoop.releaseAll()
      await client?.close()
      await executor.close()
      await Promise.all(streams)
    }
  }
}
