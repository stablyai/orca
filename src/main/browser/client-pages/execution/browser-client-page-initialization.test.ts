import { BrowserRoutePageAvailability } from '../../routing/guest-authority/browser-route-page-availability'
import { expect, it, vi } from 'vitest'
import { BrowserClientPageCommandExecutor } from './browser-client-page-command-executor'
import { BrowserClientHostCommandDispatcher } from '../../client-hosts/commands/browser-client-host-command-dispatcher'
import { createCommand, createHarness } from './browser-client-page-command-executor-test-harness'
import type { BrowserClientHostCommandEvent } from '../../../../shared/browser/client-hosting/browser-client-host-protocol'

const create = (): BrowserClientHostCommandEvent =>
  createCommand('createPage', {
    command: {
      type: 'createPage',
      browserProfileId: 'profile-a',
      executionHostKey: 'execution-host-a',
      initialUrl: 'https://example.internal/path'
    }
  })
const close = (sequence: number): BrowserClientHostCommandEvent => ({
  ...create(),
  commandSequence: sequence,
  commandId: `close-${sequence}`,
  command: { type: 'closePage', targetAuthority: create() }
})

it('keeps initialization inventory requested, then adopts the committed redirect without an ordinary URL overwrite', async () => {
  const { dependencies } = createHarness()
  const commit = Promise.withResolvers<string>()
  const executor = new BrowserClientPageCommandExecutor({
    ...dependencies,
    routeWebContents: {
      ...dependencies.routeWebContents,
      initializeGuest: vi.fn(() => commit.promise)
    }
  })
  const dispatcher = new BrowserClientHostCommandDispatcher({
    authority: create(),
    handler: (event, signal, close) => executor.handle(event, signal, close),
    acquireInitialization: (event) => executor.acquireInitialization(event)
  })
  await dispatcher.dispatch(create())
  expect(executor.snapshotPageInventory()[0]).toMatchObject({
    state: 'outcomeUnknown',
    currentUrl: 'https://example.internal/path'
  })
  const navigation = dispatcher.dispatch(createCommand('navigate'))
  commit.resolve('https://example.internal/final')
  await expect(navigation).resolves.toEqual({
    status: 'completed',
    value: 'https://example.internal/final'
  })
  expect(executor.snapshotPageInventory()[0]).toMatchObject({
    state: 'active',
    currentUrl: 'https://example.internal/final'
  })
  expect(dependencies.routeWebContents.navigateGuest).not.toHaveBeenCalled()
  await dispatcher.dispatch(close(3))
  expect(executor.snapshotPageInventory()).toEqual([])
  await dispatcher.close()
  await executor.close()
})

it.each(['create', 'gap', 'navigate'] as const)(
  'an exact terminal close cancels %s and stays ordered through cleanup',
  async (phase) => {
    const { dependencies, route, renderer } = createHarness()
    const mount = Promise.withResolvers<{ webContentsId: number }>()
    const navigating = Promise.withResolvers<void>()
    if (phase === 'create') {
      renderer.mountPage.mockImplementationOnce(() => mount.promise)
    }
    const executor = new BrowserClientPageCommandExecutor({
      ...dependencies,
      routeWebContents: {
        ...dependencies.routeWebContents,
        initializeGuest: vi.fn((_claim, _url, signal) => {
          navigating.resolve()
          return new Promise<string>((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          )
        })
      }
    })
    const results: string[] = []
    const dispatcher = new BrowserClientHostCommandDispatcher({
      authority: create(),
      handler: async (event, signal, close) => {
        const result = await executor.handle(event, signal, close)
        results.push(event.command.type)
        return result
      },
      acquireInitialization: (event) => executor.acquireInitialization(event)
    })
    const creation = dispatcher.dispatch(create())
    if (phase !== 'create') {
      await creation
    }
    let navigation: Promise<unknown> | undefined
    if (phase === 'navigate') {
      navigation = dispatcher.dispatch(createCommand('navigate'))
      await navigating.promise
    }
    const stale = close(phase === 'navigate' ? 3 : 2)
    if (stale.command.type === 'closePage') {
      stale.command.targetAuthority = { ...stale.command.targetAuthority, pageHostGeneration: 6 }
    }
    // Rejected stale targets cannot abort the initializer even when normally admitted to the terminal queue.
    if (phase === 'gap') {
      await expect(dispatcher.dispatch(stale)).resolves.toMatchObject({ status: 'failed' })
    }
    const closing = dispatcher.dispatch(close(phase === 'navigate' || phase === 'gap' ? 3 : 2))
    if (phase === 'create') {
      mount.resolve({ webContentsId: 41 })
    }
    await creation
    await navigation
    await expect(closing).resolves.toEqual({ status: 'completed' })
    expect(results.at(-1)).toBe('closePage')
    expect(executor.snapshotPageInventory()).toEqual([])
    expect(route.release).toHaveBeenCalledOnce()
    await dispatcher.close()
    await executor.close()
  }
)

it('a shared availability report cancels only its exact environment guest during initialization', async () => {
  const availability = new BrowserRoutePageAvailability()
  const signal = new AbortController().signal
  const peers = ['a', 'b'].map((name, index) => {
    const h = createHarness()
    h.routeSession.partition = `persist:orca-browser-v1-${name.repeat(64)}`
    h.renderer.rendererWebContentsId = 11 + index
    h.renderer.mountPage.mockResolvedValue({ webContentsId: 41 + index })
    const started = Promise.withResolvers<AbortSignal>()
    const executor = new BrowserClientPageCommandExecutor({
      ...h.dependencies,
      routeWebContents: {
        ...h.dependencies.routeWebContents,
        watchPageAvailability: availability.watch,
        initializeGuest: (_claim, _url, pending) => {
          started.resolve(pending)
          return new Promise<string>((_resolve, reject) =>
            pending.addEventListener('abort', () => reject(new Error('guest-lost')), { once: true })
          )
        }
      }
    })
    const command = { ...create(), pageHostGeneration: 7 + index }
    return { ...h, executor, started, command }
  })
  try {
    await Promise.all(peers.map((p) => p.executor.handle(p.command, signal)))
    const navigations = peers.map((p) =>
      p.executor.handle(
        {
          ...p.command,
          commandSequence: 2,
          commandId: 'navigate',
          command: { type: 'navigate', url: 'https://example.internal/path' }
        },
        signal
      )
    )
    const [a, b] = await Promise.all(peers.map((p) => p.started.promise))
    availability.report(peers[0].dependencies.routeWebContents.claimGuestLifecycle.mock.calls[0][0])
    await expect(navigations[0]).resolves.toMatchObject({ status: 'failed' })
    expect(a.aborted).toBe(true)
    expect(b.aborted).toBe(false)
    availability.report(peers[1].dependencies.routeWebContents.claimGuestLifecycle.mock.calls[0][0])
    await expect(navigations[1]).resolves.toMatchObject({ status: 'failed' })
    expect(b.aborted).toBe(true)
  } finally {
    await Promise.all(peers.map((p) => p.executor.close()))
  }
})
