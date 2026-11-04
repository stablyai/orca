import { afterEach, expect, it } from 'vitest'
import { getRequestedPageUrl } from '../browser/cdp/input/browser-expected-page-url'
import type { RuntimeBrowserCommands } from './browser/browser-commands'
import { setRuntimeBrowserCommandsFactory } from './runtime-browser-commands-factory'
import { RuntimeEdgeCommandController } from './runtime-edge-command-controller'

afterEach(() => setRuntimeBrowserCommandsFactory(null))

it('lets a browser command read the URL its RPC params expect, for that call only', async () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test calls one method, and the proxy answers every name the controller binds.
  const commands = new Proxy({} as RuntimeBrowserCommands, {
    get: () => async () => getRequestedPageUrl()
  })
  setRuntimeBrowserCommandsFactory(() => commands)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these hosts are only used by commands the test never calls.
  const hosts = {
    browserHost: {},
    jiraHost: {},
    screencast: {},
    emulatorHost: {}
  } as unknown as ConstructorParameters<typeof RuntimeEdgeCommandController>[0]
  const { surface } = new RuntimeEdgeCommandController(hosts)

  await expect(
    surface.browserClick({ element: '@e1', expectUrl: 'https://example.com/a' })
  ).resolves.toBe('https://example.com/a')
  await expect(surface.browserClick({ element: '@e1' })).resolves.toBeUndefined()
})
