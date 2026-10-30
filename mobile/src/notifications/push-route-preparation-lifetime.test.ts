import {
  createRouteDeclarationFixture,
  routeDeclarationPorts,
  requests,
  settle
} from './push-route-declaration-ports.test-fixture'
import { PushRouteDeclarationSchema } from '../../../cloud/packages/push-contract/src/route-declaration'
import * as SecureStore from 'expo-secure-store'
import { expect, it, vi } from 'vitest'

const fixture = createRouteDeclarationFixture()
const state = routeDeclarationPorts()
const token = state.token
const register = fixture.register

it.each(['saved', 'missing'] as const)(
  'releases obsolete %s key preparations at every owner boundary and preserves current successor duty',
  async (kind) => {
    const { AppState } = await import('react-native')
    const actions = [
      'disable',
      'stop',
      'restart',
      'detach',
      're-pair',
      'remove',
      'token',
      'renewal',
      'background',
      'filter-failure',
      'consent-failure'
    ] as const
    for (const action of actions) {
      const context = `${kind}/${action}`
      fixture.stop?.()
      fixture.stop = undefined
      vi.resetModules()
      vi.clearAllMocks()
      AppState.currentState = 'active'
      state.storage.set('orca:pushServiceNotificationsEnabled', 'true')
      state.storage.delete('orca:push-route-version')
      if (kind === 'missing') {
        state.keys.clear()
      }
      const pending = Promise.withResolvers<string | null>()
      try {
        vi.mocked(SecureStore.getItemAsync).mockImplementationOnce(() => pending.promise)
        fixture.publisher = await import('./push-route-declaration')
        const source = await import('./push-route-declaration-build')
        const prepare = fixture.publisher.mobilePushRouteKey
        const held: {
          result: ReturnType<typeof prepare>['result']
          predicate: ReturnType<typeof vi.fn<() => boolean>>
          retired: boolean
          calls: number
        }[] = []
        vi.spyOn(fixture.publisher, 'mobilePushRouteKey').mockImplementation((current) => {
          const predicate = vi.fn(current)
          const handle = prepare(predicate)
          const entry = { result: handle.result, predicate, retired: false, calls: 0 }
          held.push(entry)
          void handle.result.then((result) => {
            if (result.status === 'retired') {
              entry.retired = true
              entry.calls = predicate.mock.calls.length
            }
          })
          return handle
        })
        const { send, respond, operations, current } = requests()
        const receipts: {
          action: 'read' | 'replace'
          status: number
          version: number | null
          expectedVersion?: number | null
        }[] = []
        send.mockImplementation(async (_url, init) => {
          const response = respond(init)
          const operation = operations.at(-1)
          if (!operation) {
            throw new Error('Missing actual route operation')
          }
          const q = JSON.stringify([
            operation.platform,
            operation.apnsEnvironment,
            operation.token,
            operation.routeKey
          ])
          receipts.push(
            operation.action === 'replace'
              ? {
                  action: operation.action,
                  status: response.status,
                  version: operation.version,
                  expectedVersion: operation.expectedVersion
                }
              : {
                  action: operation.action,
                  status: response.status,
                  version: current.get(q)?.version ?? null
                }
          )
          return response
        })
        const registration = await import('./push-registration')
        const client = () => ({
          sendRequest: vi.fn(async (method: string) => ({
            id: 'key-race',
            ok: true as const,
            result:
              method === 'status.get'
                ? {
                    capabilities: [
                      registration.NOTIFICATIONS_REMOTE_PUSH_CAPABILITY,
                      'notifications.push-route-key.v1'
                    ]
                  }
                : { registered: true, gatewayOrigin: 'https://push.onorca.dev', unregistered: true }
          }))
        })
        const old = client()
        fixture.stop = registration.startPushTokenSync()
        const detach = registration.attachPushRegistration('host-0', old)
        await settle()
        const registerCalls = () =>
          old.sendRequest.mock.calls.filter(([method]) => method === 'notifications.registerPush')
        expect(registerCalls(), context).toHaveLength(0)
        const replacement = client()
        let recover: (() => void) | undefined
        if (action === 'disable') {
          await registration.setRemotePushEnabled(false)
        } else if (action === 'restart' || action === 'stop') {
          fixture.stop()
          if (action === 'restart') {
            fixture.stop = registration.startPushTokenSync()
          }
        } else if (action === 'detach') {
          detach()
          registration.attachPushRegistration('host-0', replacement)
        } else if (action === 're-pair' || action === 'remove') {
          // Removal and its real unregister finish before the physical read is released.
          recover = await registration.unregisterPushForRemovedHost('host-0')
          if (action === 're-pair') {
            registration.attachPushRegistration('host-0', replacement)
          }
        } else if (action === 'token') {
          state.callbacks.listener?.({ ...token, token: 'cd'.repeat(32) })
        } else if (action === 'renewal') {
          state.callbacks.appState?.('active')
        } else if (action === 'background') {
          AppState.currentState = 'background'
          state.callbacks.appState?.('background')
        } else {
          const storage = (await import('@react-native-async-storage/async-storage')).default
          const save = vi
            .spyOn(storage, 'setItem')
            .mockRejectedValueOnce(new Error('local persistence failed'))
          const result =
            action === 'consent-failure'
              ? registration.setRemotePushEnabled(false)
              : registration.setNotificationDeliveryPreferences({
                  onlyWhenDesktopAway: false,
                  sound: false,
                  suppressWhileViewing: true
                })
          await expect(result).rejects.toThrow('local persistence failed')
          save.mockRestore()
        }
        await settle()
        expect(registerCalls(), context).toHaveLength(0)
        if (action === 'disable' || action === 'remove' || action === 're-pair') {
          expect(
            old.sendRequest.mock.calls.some(([method]) => method === 'notifications.unregisterPush')
          ).toBe(true)
        }
        expect(held[0]?.retired, context).toBe(true)
        expect(
          source.pushRoutePreparationSnapshotForTests().keyEntries,
          context
        ).toBeLessThanOrEqual(2)
        if (action === 'disable' || action === 'stop') {
          expect(
            source.pushRoutePreparationSnapshotForTests(),
            `${context}: all owners retired`
          ).toMatchObject({
            keyEntries: 0,
            creator: 0,
            builderCallables: 0,
            builderPayloads: 0,
            builderBodies: 0
          })
        }
        if (action === 'background' || action === 'remove') {
          expect(
            held.every((entry) => entry.retired),
            `${context}: exact host results retired`
          ).toBe(true)
          expect(
            registration.pushRegistrationSnapshotForTests(),
            `${context}: no host interest`
          ).toEqual({
            preparations: 0,
            runners: 0
          })
          // Installation publication survives host retirement for saved disconnected recovery.
          expect(
            source.pushRoutePreparationSnapshotForTests(),
            `${context}: current publisher only`
          ).toMatchObject({
            keyEntries: 1,
            keyCallables: 1,
            keyTask: 1,
            creator: 0,
            builder: 1,
            latest: 0,
            builderCallables: 1,
            builderPayloads: 1,
            builderBodies: 0
          })
        }
        pending.resolve(kind === 'saved' ? (state.keys.get('orca.push-route-key') ?? null) : null)
        await settle()
        for (const entry of held.filter((entry) => entry.retired)) {
          expect(entry.predicate, context).toHaveBeenCalledTimes(entry.calls)
        }
        expect(source.pushRoutePreparationSnapshotForTests().keyEntries, context).toBe(0)
        const absent =
          action === 'disable' ||
          action === 'stop' ||
          action === 'background' ||
          action === 'remove'
        expect(registerCalls(), context).toHaveLength(
          absent || action === 're-pair' || action === 'detach' ? 0 : 1
        )
        expect(
          replacement.sendRequest.mock.calls.filter(
            ([method]) => method === 'notifications.registerPush'
          )
        ).toHaveLength(action === 're-pair' || action === 'detach' ? 1 : 0)
        expect(SecureStore.setItemAsync, context).toHaveBeenCalledTimes(
          kind === 'missing' && !absent ? 1 : 0
        )
        const publisherLive = kind === 'saved' && (action === 'background' || action === 'remove')
        const publicationContext = `${context}: independent authenticated publisher; actual operations ${JSON.stringify(receipts)}`
        if (kind === 'saved' && action === 'renewal') {
          expect(
            operations.map((operation) => operation.action),
            publicationContext
          ).toEqual(['read', 'replace', 'read', 'replace'])
          const [initial, renewal] = operations.filter(
            (operation) => operation.action === 'replace'
          )
          if (!initial || !renewal) {
            throw new Error(`${publicationContext}: missing initial or owed renewal replace`)
          }
          const q = [initial.platform, initial.apnsEnvironment, initial.token, initial.routeKey]
          expect(
            operations.map((operation) => [
              operation.platform,
              operation.apnsEnvironment,
              operation.token,
              operation.routeKey
            ]),
            publicationContext
          ).toEqual([q, q, q, q])
          expect(initial, publicationContext).toMatchObject(token)
          expect(initial.expectedVersion, publicationContext).toBeNull()
          expect(renewal.expectedVersion, publicationContext).toBe(initial.version)
          expect(renewal.version, publicationContext).toBeGreaterThan(initial.version)
          expect(renewal.hosts, publicationContext).toEqual(initial.hosts)
          expect(initial.hosts, publicationContext).toHaveLength(1)
          expect(receipts, publicationContext).toEqual([
            { action: 'read', status: 200, version: null },
            { action: 'replace', status: 200, version: initial.version, expectedVersion: null },
            { action: 'read', status: 200, version: initial.version },
            {
              action: 'replace',
              status: 200,
              version: renewal.version,
              expectedVersion: initial.version
            }
          ])
          expect(current.get(JSON.stringify(q)), publicationContext).toEqual({
            version: renewal.version,
            hosts: initial.hosts
          })
          expect(state.storage.get('orca:push-route-version'), publicationContext).toBe(
            String(renewal.version)
          )
          expect(send, publicationContext).toHaveBeenCalledTimes(receipts.length)
          const completedOperations = operations.slice()
          const completedReceipts = receipts.slice()
          await settle()
          expect(operations, `${context}: no new wake`).toEqual(completedOperations)
          expect(receipts, `${context}: no new wake`).toEqual(completedReceipts)
          expect(send, `${context}: no new wake`).toHaveBeenCalledTimes(completedReceipts.length)
        } else {
          expect(send, publicationContext).toHaveBeenCalledTimes(publisherLive || !absent ? 2 : 0)
        }
        if (action === 'remove') {
          recover?.()
          await settle()
          expect(registerCalls(), context).toHaveLength(1)
        }
        fixture.stop?.()
        fixture.stop = undefined
        await settle()
        expect(
          source.pushRoutePreparationSnapshotForTests(),
          `${context}: all owners stopped`
        ).toMatchObject({
          keyEntries: 0,
          keyCallables: 0,
          creator: 0,
          builderCallables: 0,
          builderPayloads: 0,
          builderBodies: 0
        })
      } finally {
        fixture.stop?.()
        fixture.stop = undefined
        pending.resolve(null)
        await settle()
      }
    }
  }
)

it.each([
  'version-read',
  'barrier',
  'catalog',
  'version-save',
  'route-read',
  'route-replace'
] as const)(
  'retires complete publisher interests across root replacement while %s is held',
  async (stage) => {
    const storage = (await import('@react-native-async-storage/async-storage')).default
    const source = await import('./push-route-declaration-build')
    const registration = await import('./push-registration')
    const queue = await import('../transport/host-list-mutation-queue')
    state.storage.set('orca:push-route-version', '1')
    const gate = Promise.withResolvers<void>()
    let issuedVersion: number | undefined
    const get = storage.getItem.bind(storage)
    const set = storage.setItem.bind(storage)
    let held = false
    vi.spyOn(storage, 'getItem').mockImplementation(async (key) => {
      if (
        !held &&
        ((stage === 'version-read' && key === 'orca:push-route-version') ||
          (stage === 'catalog' && key === 'orca:hosts'))
      ) {
        held = true
        await gate.promise
      }
      return get(key)
    })
    vi.spyOn(storage, 'setItem').mockImplementation(async (key, value) => {
      if (!held && stage === 'version-save' && key === 'orca:push-route-version') {
        held = true
        issuedVersion = Number(value)
        await gate.promise
      }
      return set(key, value)
    })
    if (stage === 'barrier') {
      void queue.enqueueHostListMutation(async () => {
        held = true
        await gate.promise
      })
    }
    const build = source.preparePushRouteReconciliation
    const interests: {
      retired: boolean
      calls: number
      predicate: ReturnType<typeof vi.fn<() => boolean>>
    }[] = []
    vi.spyOn(source, 'preparePushRouteReconciliation').mockImplementation((value, current) => {
      const predicate = vi.fn(current)
      const handle = build(value, predicate)
      const interest = { predicate, retired: false, calls: 0 }
      interests.push(interest)
      void handle.result.then((result) => {
        if (result.status === 'retired') {
          interest.retired = true
          interest.calls = predicate.mock.calls.length
        }
      })
      return handle
    })
    const { bodies, send, respond } = requests()
    if (stage === 'route-read' || stage === 'route-replace') {
      send.mockImplementation(async (_url, init) => {
        const action = PushRouteDeclarationSchema.parse(JSON.parse(String(init?.body))).action
        if (!held && action === (stage === 'route-read' ? 'read' : 'replace')) {
          held = true
          await gate.promise
        }
        return respond(init)
      })
    }
    try {
      for (const changes of [10, 100]) {
        for (let i = 0; i < changes; i++) {
          fixture.stop?.()
          fixture.stop = registration.startPushTokenSync()
          await register()
          state.callbacks.listener?.({
            ...token,
            token: (changes + i).toString(16).padStart(64, '0')
          })
          await settle()
          expect(held).toBe(true)
          expect(send).toHaveBeenCalledTimes(
            stage === 'route-replace'
              ? 2
              : stage === 'version-save' || stage === 'route-read'
                ? 1
                : 0
          )
          expect(source.pushRoutePreparationSnapshotForTests()).toMatchObject({
            keyTask: 0,
            keyEntries: 0,
            builder: 1,
            latest: 1,
            builderCallables: 1,
            builderPayloads: 1,
            builderBodies: 0
          })
        }
        fixture.stop?.()
        fixture.stop = undefined
        await settle()
        expect(interests.every((interest) => interest.retired)).toBe(true)
        expect(source.pushRoutePreparationSnapshotForTests()).toMatchObject({
          keyEntries: 0,
          builder: 1,
          latest: 0,
          builderCallables: 0,
          builderPayloads: 0,
          builderBodies: 0
        })
      }
      fixture.stop = registration.startPushTokenSync()
      await register()
      gate.resolve()
      await settle()
      expect(send).toHaveBeenCalledTimes(
        stage === 'route-replace' ? 4 : stage === 'version-save' || stage === 'route-read' ? 3 : 2
      )
      expect(bodies.at(-1)).toMatchObject({ token: token.token })
      if (issuedVersion !== undefined) {
        expect(bodies.at(-1)?.version).toBeGreaterThan(issuedVersion)
      }
      for (const interest of interests.filter((interest) => interest.retired)) {
        expect(interest.predicate).toHaveBeenCalledTimes(interest.calls)
      }
      expect(source.pushRoutePreparationSnapshotForTests()).toMatchObject({
        builder: 0,
        latest: 0,
        builderCallables: 0,
        builderPayloads: 0,
        builderBodies: 0
      })
    } finally {
      gate.resolve()
      await settle()
    }
  }
)
