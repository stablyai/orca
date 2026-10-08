import { beforeEach, expect, it, vi } from 'vitest'

type Handler = (event: unknown, args: { id: unknown }) => Promise<boolean>

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  olderPtyIds: new Set<string>(),
  startup: vi.fn<() => Promise<void> | undefined>()
}))
vi.mock('../../pty-host-bindings', () => ({
  getPtyIpc: () => ({
    handle: (channel: string, handler: Handler) => mocks.handlers.set(channel, handler)
  })
}))
vi.mock('../../../daemon/daemon-provider-state', () => ({
  isTerminalFromBeforeDaemonProtocol: (id: string, protocolVersion: number) =>
    protocolVersion === 42 && mocks.olderPtyIds.has(id)
}))

import { installPtyClaudeOldTerminalIpcHandler } from './claude-old-terminal'

beforeEach(() => {
  mocks.handlers.clear()
  mocks.olderPtyIds = new Set(['old-1'])
  installPtyClaudeOldTerminalIpcHandler({ getLocalPtyProviderStartupPromise: mocks.startup })
})

it('answers true only for a pane owned by a daemon from before per-account Claude folders', async () => {
  const ask = mocks.handlers.get('pty:openedBeforeClaudeAccounts')!
  expect(await ask({}, { id: 'old-1' })).toBe(true)
  // A pane on this build's daemon, or an SSH pane, which no local daemon owns.
  expect(await ask({}, { id: 'new-1' })).toBe(false)
  expect(await ask({}, { id: 'ssh:conn-1:pty-1' })).toBe(false)
  expect(await ask({}, { id: 42 })).toBe(false)
  expect(mocks.startup).toHaveBeenCalled()
})
