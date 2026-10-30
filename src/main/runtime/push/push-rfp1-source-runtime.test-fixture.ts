import { join } from 'node:path'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import { releaseModuleExport } from '../../../../tests/e2e/cross-version-wire/release-module-export'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import type { createProfileStateStore } from '../../persistence/profile-state/profile-state-store-factory'
import type { getDefaultPersistedState } from '../../../shared/constants'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { OrcaRuntimeRpcServer } from '../runtime-rpc'
import type { RpcAnyMethodDeclaration } from '../rpc/core'
import type { JournalHostDatabase } from '../../native-chat/agent-session-journal/journal-host-database'
import type { AgentSessionRecordStore } from '../agent-session-record-store'
import type { StructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-host'
import type { StructuredAgentRegistry } from '../../native-chat/agent-session-wire/structured-agent-registry'
import type { StructuredAgentSessionAdapterRouter } from '../../native-chat/agent-session-wire/structured-agent-session-adapter-router'
import type { setStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { createStructuredAttentionMobileDelivery } from '../structured-agent-session-mobile-attention'
import type { DesktopPushService } from './desktop-push-service'
import type { PushGatewayClient } from './push-gateway-client'
import { agentSessionRecordFixture } from '../../native-chat/agent-session-record-test-fixture'
import { observationRelayWire, type ObservationCapture } from './push-rfp1-relay.test-fixture'
import { ownerCleanup } from './push-owner-bridge.test-fixture'
import { record, text } from '../../../../cloud/apps/push/src/push-owner-integration.test-fixture'

export const RFP1_OLD = '7f4c8f606435d4ca90964e176e860626ffba918a'
export const RFP1_A = '346a89077ce7973bb56379757bf4a6bbeb5cba00'
export const RFP1_WORKSPACE = 'observation::/observation/w1'
export const RFP1_ALERT_SESSION = 'alert-session'
export const RFP1_VIEW_SESSION = 'view-session'

export async function observationRuntime(options: {
  scratch: string
  archiveRoot: string
  id: string
  pin: string
  port?: number
  fetch: typeof fetch
  capture: ObservationCapture
}) {
  const profile = join(options.scratch, options.id, 'profile')
  const newProfile = !existsSync(profile)
  mkdirSync(profile, { recursive: true })
  const dataFile = join(profile, 'state.json')
  const archivePath = join(
    import.meta.dirname,
    '../../../../tests/e2e/cross-version-wire/release-checkout.ts'
  )
    .split('\\')
    .join('/')
  const archiveNamespace: unknown = await import(/* @vite-ignore */ archivePath)
  const { materializeReleaseCheckout, importReleaseCheckoutModule } = record(archiveNamespace)
  if (
    typeof materializeReleaseCheckout !== 'function' ||
    typeof importReleaseCheckoutModule !== 'function'
  ) {
    throw new Error('Observation requires the actual release checkout materializer and importer')
  }
  const materialized: unknown = await materializeReleaseCheckout(options.pin, {
    cacheRoot: join(options.archiveRoot, options.id, 'sources', options.pin)
  })
  const fields = record(materialized)
  const checkout = {
    ref: text(fields.ref),
    commit: text(fields.commit),
    label: text(fields.label),
    root: text(fields.root)
  }
  const blobs = await runProcess({
    program: 'git',
    args: [
      'ls-tree',
      checkout.commit,
      '--',
      'src/main/runtime/rpc/methods/status.ts',
      'src/main/runtime/orca-runtime-get-status.ts',
      'src/shared/mobile-runtime-capabilities.ts',
      'src/main/runtime/mobile-desktop-relay/mobile-desktop-relay.ts',
      'src/main/runtime/mobile-desktop-relay/relayed-phone-frames.ts',
      'src/main/runtime/push/push-dispatcher.ts',
      'src/main/runtime/push/push-gateway-client.ts',
      'src/main/native-chat/agent-session-wire/structured-agent-session-turn-completion-feed.ts',
      'src/main/notifications/forwarded-push-authority.ts',
      'src/main/ipc/notifications.ts',
      'src/renderer/src/components/native-chat/structured-attention-dispatch.ts',
      'mobile/src/transport/execution-host-scoped-rpc-client.ts',
      'mobile/src/transport/host-status-probe-operations.ts'
    ],
    cwd: process.cwd(),
    timeoutMs: 5000
  })
  if (blobs.code !== 0) {
    throw new Error('Could not record actual archived producer blob identities')
  }
  options.capture({
    boundary: 'source-pin-and-blobs',
    actor: options.id,
    pin: checkout.commit,
    blobs: blobs.stdout
  })
  const wire = observationRelayWire(checkout.root, checkout.commit, options.capture)
  const load = async <T>(path: string, name: string): Promise<T> => {
    const namespace: unknown = await importReleaseCheckoutModule(checkout, path)
    return releaseModuleExport<T>(record(namespace), name)
  }
  // Explicit methods below must never consume the archived default manifest.
  const unused: RpcAnyMethodDeclaration[] = []
  unused[Symbol.iterator] = () => {
    throw new Error('Observation consumed the unused default RPC manifest')
  }
  vi.doMock(join(checkout.root, 'src/main/runtime/rpc/methods.ts'), () => ({
    ALL_RPC_METHODS: unused
  }))
  vi.doMock(join(checkout.root, 'src/main/git/worktree.ts'), () => ({
    listWorktrees: async () => [
      { path: '/observation/w1', head: 'abc', branch: 'main', isBare: false, isMainWorktree: true }
    ],
    listWorktreesStrict: async () => [
      { path: '/observation/w1', head: 'abc', branch: 'main', isBare: false, isMainWorktree: true }
    ]
  }))
  const createStore = await load<typeof createProfileStateStore>(
    'src/main/persistence/profile-state/profile-state-store-factory.ts',
    'createProfileStateStore'
  )
  if (typeof createStore !== 'function') {
    throw new Error('Observation requires the archived writable profile factory')
  }
  const defaults = await load<typeof getDefaultPersistedState>(
    'src/shared/constants.ts',
    'getDefaultPersistedState'
  )
  if (newProfile) {
    const state = defaults(profile)
    state.repos = [
      {
        id: 'observation',
        path: '/observation',
        importedExternalWorktreePaths: ['/observation/w1'],
        displayName: 'Observation',
        badgeColor: 'blue',
        addedAt: 1
      }
    ]
    state.settings.notifications = {
      ...state.settings.notifications,
      enabled: options.id !== 'B',
      agentTaskComplete: true,
      terminalBell: true,
      mutedNotificationSourceIds: []
    }
    writeFileSync(dataFile, JSON.stringify(state), { flag: 'wx' })
  }
  const Runtime = await load<typeof OrcaRuntimeService>(
    'src/main/runtime/orca-runtime.ts',
    'OrcaRuntimeService'
  )
  const Rpc = await load<typeof OrcaRuntimeRpcServer>(
    'src/main/runtime/runtime-rpc.ts',
    'OrcaRuntimeRpcServer'
  )
  const methods: RpcAnyMethodDeclaration[] = []
  for (const [file, symbol] of [
    ['status', 'STATUS_METHODS'],
    ['pairing', 'PAIRING_METHODS'],
    ['mobile-relay-hosts', 'MOBILE_RELAY_HOSTS_METHODS'],
    ['client-ui', 'CLIENT_UI_METHODS'],
    ['runtime-client-capabilities', 'RUNTIME_CLIENT_CAPABILITY_METHODS'],
    ['notifications', 'NOTIFICATION_METHODS'],
    ['session-tabs', 'SESSION_TAB_METHODS'],
    ['worktree-catalog-methods', 'WORKTREE_CATALOG_METHODS'],
    ['folder-workspace', 'FOLDER_WORKSPACE_METHODS'],
    [
      'structured-agent-session-turn-completion-stream',
      'STRUCTURED_AGENT_SESSION_TURN_COMPLETION_METHODS'
    ]
  ] as const) {
    methods.push(
      ...(await load<readonly RpcAnyMethodDeclaration[]>(
        `src/main/runtime/rpc/methods/${file}.ts`,
        symbol
      ))
    )
  }
  const store = createStore({
    userDataPath: profile,
    dataFile,
    databaseFile: join(profile, 'profile-state.db'),
    profileId: options.id
  }).store
  let ownedServer: OrcaRuntimeRpcServer | undefined
  const subscribed = Promise.withResolvers<void>()
  const releaseSpies: (() => void)[] = []
  let host: StructuredAgentSessionHost | undefined
  let database: JournalHostDatabase | undefined
  let service: DesktopPushService | null = null
  let uninstall: typeof setStructuredAgentSessionHost | undefined
  let closePromise: Promise<void> | undefined
  const cleanup = (primary?: { failed: true; error: unknown }) =>
    (closePromise ??= (async () => {
      const closing = ownerCleanup(primary)
      await closing.run(() => wire.release())
      await closing.run(() => service?.stop())
      await closing.run(async () => {
        const reset = await load<
          typeof import('../../ipc/runtime-environments/runtime-environment-request-connections').resetRuntimeEnvironmentStatusOwners
        >(
          'src/main/ipc/runtime-environments/runtime-environment-request-connections.ts',
          'resetRuntimeEnvironmentStatusOwners'
        )
        reset()
      })
      await closing.run(() => ownedServer?.setMobileDesktopRelayHosts(null))
      await closing.run(() => ownedServer?.stop())
      await closing.run(() => host?.flushAllStreamedEvents())
      await closing.run(() => uninstall?.(null))
      await closing.run(() => database?.close())
      for (const restore of releaseSpies) {
        await closing.run(restore)
      }
      await closing.run(() => store.flushFinalOrThrowAsync())
      await closing.run(() => store.freezeWritesAsync())
      closing.finish()
    })())
  try {
    if (
      typeof store.flushFinalOrThrowAsync !== 'function' ||
      typeof store.freezeWritesAsync !== 'function'
    ) {
      throw new Error('Observation requires archived throwing checkpoint and awaited close')
    }
    const runtime = new Runtime(store)
    const server = new Rpc({
      runtime,
      userDataPath: profile,
      methods,
      enableWebSocket: true,
      wsPort: options.port ?? 0,
      pinnedBindHost: '127.0.0.1'
    })
    ownedServer = server
    await server.start()
    const Service = await load<typeof DesktopPushService>(
      'src/main/runtime/push/desktop-push-service.ts',
      'DesktopPushService'
    )
    const Client = await load<typeof PushGatewayClient>(
      'src/main/runtime/push/push-gateway-client.ts',
      'PushGatewayClient'
    )
    const keypair = server.getE2EEKeypair()
    if (!keypair) {
      throw new Error('Observation runtime has no actual pairing key')
    }
    service = Service.create({
      runtime,
      runtimeRpc: server,
      gatewayUrl: 'https://push.onorca.dev',
      client: new Client({ gatewayUrl: 'https://push.onorca.dev', keypair, fetch: options.fetch })
    })
    if (!service) {
      throw new Error('Observation desktop push service did not start')
    }
    service.start()
    if (options.id === 'B' || options.id === 'D') {
      const Database = await load<typeof JournalHostDatabase>(
        'src/main/native-chat/agent-session-journal/journal-host-database.ts',
        'JournalHostDatabase'
      )
      // The externally supplied journal is installed below; the runtime reads that real host's visible index.
      database = Database.open(join(profile, 'journal'))
      mkdirSync(join(profile, 'agent-home'), { recursive: true })
      // Saved conversation records are external input; the old store decodes them itself.
      for (const sessionId of [RFP1_ALERT_SESSION, RFP1_VIEW_SESSION]) {
        database.db
          .prepare(
            'INSERT OR IGNORE INTO agent_session_records (session_id, record_json) VALUES (?, ?)'
          )
          .run(
            sessionId,
            JSON.stringify(
              agentSessionRecordFixture({
                sessionId,
                provider: 'codex',
                accountHome: { variable: 'CODEX_HOME', path: join(profile, 'agent-home') },
                location: { workspaceId: RFP1_WORKSPACE, workspaceKind: 'git-worktree' }
              })
            )
          )
      }
      const Records = await load<typeof AgentSessionRecordStore>(
        'src/main/runtime/agent-session-record-store.ts',
        'AgentSessionRecordStore'
      )
      const Host = await load<typeof StructuredAgentSessionHost>(
        'src/main/native-chat/agent-session-wire/structured-agent-session-host.ts',
        'StructuredAgentSessionHost'
      )
      const Agents = await load<typeof StructuredAgentRegistry>(
        'src/main/native-chat/agent-session-wire/structured-agent-registry.ts',
        'StructuredAgentRegistry'
      )
      const Router = await load<typeof StructuredAgentSessionAdapterRouter>(
        'src/main/native-chat/agent-session-wire/structured-agent-session-adapter-router.ts',
        'StructuredAgentSessionAdapterRouter'
      )
      const agents = new Agents([])
      const records = Records.open({ journalDatabase: database, hostId: 'local' })
      await records.showSessionTabs([RFP1_ALERT_SESSION, RFP1_VIEW_SESSION])
      host = new Host({
        store: records,
        journalDatabase: database,
        agents,
        adapter: new Router(agents, async () => {}),
        claimKeyId: 'observation-key',
        logger: { warn: console.warn, error: console.error }
      })
      uninstall = await load<typeof setStructuredAgentSessionHost>(
        'src/main/native-chat/agent-session-wire/structured-agent-session-registry.ts',
        'setStructuredAgentSessionHost'
      )
      uninstall(host)
      await host.journalSnapshot(RFP1_ALERT_SESSION)
      await host.journalSnapshot(RFP1_VIEW_SESSION)
      const sourceHost = host
      const subscribe = sourceHost.subscribeTurnCompletions
      const seen = new Set<string>()
      const observed = vi
        .spyOn(sourceHost, 'subscribeTurnCompletions')
        .mockImplementation((subscriber) => {
          const result = subscribe(subscriber)
          if (subscriber.id !== 'host-attention-delivery') {
            seen.add(subscriber.id)
            options.capture({
              boundary: 'actual-host-completion-subscription',
              pin: options.pin,
              subscriptionId: subscriber.id
            })
            if (seen.size === 2) {
              subscribed.resolve()
            }
          }
          return result
        })
      releaseSpies.push(() => observed.mockRestore())
      const createDelivery = await load<typeof createStructuredAttentionMobileDelivery>(
        'src/main/runtime/structured-agent-session-mobile-attention.ts',
        'createStructuredAttentionMobileDelivery'
      )
      const labels = await load<
        typeof import('../structured-agent-session-mobile-attention').readStructuredAttentionWorkspaceLabels
      >(
        'src/main/runtime/structured-agent-session-mobile-attention.ts',
        'readStructuredAttentionWorkspaceLabels'
      )
      const delivery = createDelivery({
        readNotificationSettings: () => store.getSettings().notifications,
        readWorkspaceLabels: (scope) => labels(store, scope),
        isWorkspaceMuted: (scope) => runtime.isWorkspaceNotificationMuted(scope.workspaceId),
        dispatch: (event) => runtime.dispatchMobileNotification(event),
        reconcile: (value) => runtime.reconcileStructuredPromptAttention(value),
        now: Date.now
      })
      host.subscribeTurnCompletions({
        id: 'host-attention-delivery',
        includePrompts: true,
        emit: (edge) => {
          if (edge.type === 'completion' || edge.type === 'prompt') {
            const id =
              edge.type === 'completion' ? edge.completion.sessionId : edge.prompt.sessionId
            delivery.deliver(edge, host?.readStatusSummary(id))
          }
        },
        onState: delivery.reconcile
      })
    }
    return {
      checkout,
      load,
      wire,
      profile,
      store,
      runtime,
      server,
      keypair,
      host,
      subscribed: subscribed.promise,
      offer(scope: 'mobile' | 'runtime', name: string) {
        const offer = server.createPairingOffer({ address: '127.0.0.1', name, scope })
        if (!offer.available) {
          throw new Error('Actual pairing offer unavailable')
        }
        return offer.pairingUrl
      },
      async commit(turnId: string) {
        const journal = host?.collaboratorsForTests().sessions.get(RFP1_ALERT_SESSION)?.journal
        if (!journal) {
          throw new Error('Actual host did not open the alert journal')
        }
        const identity = {
          provider: 'codex',
          threadId: 'source-thread',
          turnId,
          ordinal: 0
        } as const
        await journal.appendItem(
          identity,
          { kind: 'turn', turnId, state: 'running' },
          { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
        )
        await journal.appendItem(
          identity,
          { kind: 'turn', turnId, state: 'completed', outcome: 'success' },
          { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
        )
        return journal.cursor()
      },
      close: cleanup
    }
  } catch (error) {
    await cleanup({ failed: true, error })
    throw error
  }
}
