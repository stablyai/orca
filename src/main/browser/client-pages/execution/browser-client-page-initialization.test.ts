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

it('keeps the raw initializer command at the guest while returning and reconciling only safe URLs', async () => {
  const { dependencies } = createHarness()
  const raw = 'https://kagi.com/search?q=one&token=test-only'
  const initializeGuest = vi.fn(async (_claim: unknown, _url: string) => raw)
  const executor = new BrowserClientPageCommandExecutor({
    ...dependencies,
    routeWebContents: { ...dependencies.routeWebContents, initializeGuest }
  })
  const initial = create()
  if (initial.command.type !== 'createPage') {
    throw new Error('Expected create command')
  }
  initial.command = { ...initial.command, initialUrl: raw }
  const dispatcher = new BrowserClientHostCommandDispatcher({
    authority: initial,
    handler: (event, signal, close) => executor.handle(event, signal, close),
    acquireInitialization: (event) => executor.acquireInitialization(event)
  })
  await dispatcher.dispatch(initial)
  expect(executor.snapshotPageInventory()[0]?.currentUrl).toBe('https://kagi.com/search?q=one')
  const navigation = createCommand('navigate', { command: { type: 'navigate', url: raw } })
  await expect(dispatcher.dispatch(navigation)).resolves.toEqual({
    status: 'completed',
    value: 'https://kagi.com/search?q=one'
  })
  expect(initializeGuest.mock.calls[0]?.[1]).toBe(raw)
  expect(executor.snapshotPageInventory()[0]?.currentUrl).toBe('https://kagi.com/search?q=one')
  await dispatcher.close()
  await executor.close()
})
