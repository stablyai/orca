import { beforeEach, expect, it, vi } from 'vitest'

type Handler = (event: unknown, args: { id: unknown; target?: unknown }) => Promise<boolean>

type Mocks = {
  wslRunsAnotherAccount: boolean | null
  handlers: Map<string, Handler>
  legacyDaemons: Map<number, Set<string>>
  startup: ReturnType<typeof vi.fn<() => Promise<void> | undefined>>
  runsAnotherAccount: boolean | null
  router: boolean
}

const mocks = vi.hoisted((): Mocks => ({
  handlers: new Map(),
  legacyDaemons: new Map(),
  startup: vi.fn<() => Promise<void> | undefined>(),
  runsAnotherAccount: true,
  wslRunsAnotherAccount: true,
  router: true
}))
vi.mock('../../pty-host-bindings', () => ({
  getPtyIpc: () => ({
    handle: (channel: string, handler: Handler) => mocks.handlers.set(channel, handler)
  })
}))
vi.mock('../../../daemon/daemon-provider-state', () => ({
  isTerminalOnLegacyDaemon: (id: string, matches: (protocolVersion: number) => boolean) =>
    [...mocks.legacyDaemons].some(([version, ids]) => matches(version) && ids.has(id))
}))
vi.mock('../../../claude-accounts/claude-profile-installed-router', () => ({
  getClaudeProfileRouter: () =>
    mocks.router ? { systemDefaultRunsAnotherAccount: () => mocks.runsAnotherAccount } : undefined,
  getClaudeWslProfileRouter: () =>
    mocks.router
      ? {
          systemDefaultRunsAnotherAccount: async (distro: string) =>
            distro === 'Ubuntu' ? mocks.wslRunsAnotherAccount : null
        }
      : undefined
}))

import { installPtyClaudeOldTerminalIpcHandler } from './claude-old-terminal'

beforeEach(() => {
  mocks.handlers.clear()
  // v41 predates the claude function, v42 had it as v44 does, and v43 (the revert) dropped it.
  mocks.legacyDaemons = new Map([
    [41, new Set(['old-1'])],
    [42, new Set(['v42-1'])],
    [43, new Set(['v43-1'])]
  ])
  mocks.runsAnotherAccount = true
  mocks.wslRunsAnotherAccount = true
  mocks.router = true
  installPtyClaudeOldTerminalIpcHandler({ getLocalPtyProviderStartupPromise: mocks.startup })
})

const HOST = { runtime: 'host' }

it('answers true only for a pane whose daemon lacks the claude function', async () => {
  const ask = mocks.handlers.get('pty:openedBeforeClaudeAccounts')!
  expect(await ask({}, { id: 'old-1', target: HOST })).toBe(true)
  expect(await ask({}, { id: 'v43-1', target: HOST })).toBe(true)
  expect(await ask({}, { id: 'v42-1', target: HOST })).toBe(false)
  // A pane on this build's daemon, or an SSH pane, which no local daemon owns.
  expect(await ask({}, { id: 'new-1', target: HOST })).toBe(false)
  expect(await ask({}, { id: 'ssh:conn-1:pty-1', target: HOST })).toBe(false)
  expect(await ask({}, { id: 42, target: HOST })).toBe(false)
  expect(mocks.startup).toHaveBeenCalled()
})

it("judges a pane by its own runtime's selection, and hides it when that is unknown", async () => {
  const ask = mocks.handlers.get('pty:openedBeforeClaudeAccounts')!
  mocks.runsAnotherAccount = false
  expect(await ask({}, { id: 'old-1', target: HOST })).toBe(false)
  // A WSL pane asks its distro's router, not the host selection.
  const ubuntu = { runtime: 'wsl', wslDistro: 'Ubuntu' }
  expect(await ask({}, { id: 'old-1', target: ubuntu })).toBe(true)
  mocks.wslRunsAnotherAccount = false
  expect(await ask({}, { id: 'old-1', target: ubuntu })).toBe(false)
  // No account selected for the pane's runtime, no router, or no runtime at all: hidden.
  mocks.runsAnotherAccount = null
  expect(await ask({}, { id: 'old-1', target: HOST })).toBe(false)
  expect(await ask({}, { id: 'old-1', target: { runtime: 'wsl', wslDistro: 'Debian' } })).toBe(
    false
  )
  expect(await ask({}, { id: 'old-1' })).toBe(false)
  mocks.router = false
  mocks.runsAnotherAccount = true
  expect(await ask({}, { id: 'old-1', target: HOST })).toBe(false)
})
