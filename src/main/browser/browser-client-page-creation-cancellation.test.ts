import { expect, it, vi } from 'vitest'
import { createReservedBrowserClientPage } from './browser-client-page-creation'
import {
  createCommand,
  createHarness,
  createLifecycleClaim
} from './browser-client-page-command-executor-test-harness'
import {
  completeRendererMount,
  createRendererBridgeTestRig,
  sentRendererRequest
} from './browser-client-page-renderer-bridge-test-rig'

it('claims a canceled mount reply and withholds release until exact native destruction', async () => {
  const { dependencies, order, route, routeSession } = createHarness()
  const rig = createRendererBridgeTestRig()
  const renderer = rig.registry.attachRenderer(rig.endpoint)
  const controller = new AbortController()
  const commit = vi.fn()
  const { promise: destroyed, resolve: acknowledgeDestroyed } = Promise.withResolvers<void>()
  const { promise: retiring, resolve: acknowledgeRetiring } = Promise.withResolvers<void>()
  dependencies.routeWebContents.claimGuestLifecycle.mockImplementationOnce((registration) => {
    order.push('claim-guest')
    return createLifecycleClaim(registration, destroyed)
  })
  dependencies.routeWebContents.beginGuestRetirement.mockImplementationOnce(() => {
    order.push('retire-guest')
    return Promise.resolve()
  })
  vi.mocked(rig.endpoint.send).mockImplementation(() => {
    const request = sentRendererRequest(rig.endpoint)
    if (request.type === 'mountPage') {
      order.push('mount-page')
      controller.abort()
      completeRendererMount(rig, rig.endpoint, 92)
    } else if (request.type === 'retirePage') {
      order.push('retire-renderer-page')
      rig.reply(rig.endpoint, {
        type: 'retired',
        requestId: request.requestId,
        page: request.page
      })
      acknowledgeRetiring()
    }
  })

  const creation = createReservedBrowserClientPage(
    {
      ...dependencies,
      selectRenderer: () => renderer,
      retireSupersededExecutionHostPages: async () => {}
    },
    createCommand('createPage'),
    controller.signal,
    () => {},
    commit
  )
  const creationResult = creation.catch((error: unknown) => error)

  await retiring
  expect(order).toEqual([
    'retain-route',
    'prepare-page',
    'mount-page',
    'claim-guest',
    'retire-guest',
    'retire-renderer-page'
  ])
  expect(dependencies.routeWebContents.claimGuestLifecycle).toHaveBeenCalledWith({
    ...sentRendererRequest(rig.endpoint).page,
    rendererWebContentsId: rig.endpoint.id,
    webContentsId: 92
  })
  expect(routeSession.release).not.toHaveBeenCalled()
  expect(route.release).not.toHaveBeenCalled()
  expect(dependencies.routeWebContents.registerGuest).not.toHaveBeenCalled()
  expect(dependencies.routeWebContents.grantNavigation).not.toHaveBeenCalled()
  expect(commit).not.toHaveBeenCalled()

  acknowledgeDestroyed()
  await expect(creationResult).resolves.toHaveProperty(
    'message',
    'browser_client_page_command_aborted'
  )
  expect(order.slice(-2)).toEqual(['release-session', 'release-route'])
  rig.registry.dispose()
})
