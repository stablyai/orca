import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentBrowserBridge } from '../../browser/agent-browser-bridge'
import { tryAcquireConditionalWorktreeRemoval } from '../../ipc/conditional-worktree-removal-lease'
import { RuntimeBrowserPageRegistry } from '../runtime-browser-page-registry'
import { RuntimeBrowserTabCreation } from './browser-tab-creation'

const mocks = vi.hoisted(() => ({ client: vi.fn(), renderer: vi.fn() }))
vi.mock('./browser-client-page-opening', () => ({
  createBrowserClientPage: mocks.client,
  openBrowserUrlOnClient: vi.fn()
}))
vi.mock('./browser-tab-renderer-create', () => ({ createBrowserTabInRenderer: mocks.renderer }))
vi.mock('../../ipc/browser-tab-registration-wait', () => ({ waitForTabRegistration: vi.fn() }))
vi.mock('../../browser/browser-session-registry', () => ({
  browserSessionRegistry: { resolveKnownPartition: () => 'partition' }
}))

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-browser-admission-'))
})
afterEach(async () => {
  vi.clearAllMocks()
  await rm(root, { recursive: true, force: true })
})

function fixture(placement: 'client' | 'offscreen' | 'renderer') {
  let finish: ((value: { browserPageId: string }) => void) | undefined
  const created = new Promise<{ browserPageId: string }>((resolve) => {
    finish = resolve
  })
  const create = vi.fn(() => created)
  mocks.client.mockImplementation(create)
  mocks.renderer.mockImplementation(create)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked renderer creator never accesses this window.
  const window = {} as BrowserWindow
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: about:blank creation only requires this bridge to exist.
  const bridge = {} as AgentBrowserBridge
  const resolveWorkspace = vi.fn(async (id: string) => ({ id }))
  const host: ConstructorParameters<typeof RuntimeBrowserTabCreation>[0] = {
    resolveBrowserWorkspace: resolveWorkspace,
    getAgentBrowserBridge: () => null,
    resolveBrowserNetworkExecutionHost: () => {
      throw new Error('unused')
    },
    getBrowserHostLeaseRegistry: () => {
      throw new Error('unused')
    },
    getRuntimeBrowserPageRegistry: () => new RuntimeBrowserPageRegistry(),
    getAvailableAuthoritativeWindow: () => (placement === 'renderer' ? window : null),
    getAuthoritativeWindow: () => window,
    getOffscreenBrowserBackend: () => ({ createTab: create, closeTab: async () => {} }),
    serveBrowserTabs: {
      opened: () => {
        expect(tryAcquireConditionalWorktreeRemoval(root)).toEqual({ kind: 'busy' })
      },
      start: async () => false
    }
  }
  const creation = new RuntimeBrowserTabCreation(host, {
    requireAgentBrowserBridge: () => {
      expect(tryAcquireConditionalWorktreeRemoval(root)).toEqual({ kind: 'busy' })
      return bridge
    },
    notifyRendererNavigation: () => {}
  })
  const run = (worktree = `repo::${root}`) =>
    creation.browserTabCreate({
      worktree,
      url: 'about:blank',
      profileId: 'default',
      waitForRegistration: false,
      ...(placement === 'client'
        ? { placement: { kind: 'client' as const, browserHostClientId: 'host' } }
        : {})
    })
  return { run, resolveWorkspace, create, finish: () => finish?.({ browserPageId: 'page' }) }
}

it.each(['client', 'offscreen', 'renderer'] as const)(
  'holds %s creation through completion and publication',
  async (placement) => {
    const f = fixture(placement)
    const pending = f.run()
    expect(tryAcquireConditionalWorktreeRemoval(root)).toEqual({ kind: 'busy' })
    await Promise.resolve()
    expect(f.create).toHaveBeenCalledOnce()
    f.finish()
    await expect(pending).resolves.toEqual({ browserPageId: 'page' })
    const admission = tryAcquireConditionalWorktreeRemoval(root)
    expect(admission.kind).toBe('acquired')
    if (admission.kind === 'acquired') {
      admission.release()
    }
  }
)

it.each(['client', 'offscreen', 'renderer'] as const)(
  'rejects a later %s request before resolving or creating',
  async (placement) => {
    const f = fixture(placement)
    const admission = tryAcquireConditionalWorktreeRemoval(root)
    if (admission.kind !== 'acquired') {
      throw new Error('Expected closing admission')
    }
    try {
      await expect(f.run()).rejects.toThrow('removal is in progress')
      expect(f.resolveWorkspace).not.toHaveBeenCalled()
      expect(f.create).not.toHaveBeenCalled()
    } finally {
      admission.release()
    }
  }
)

it.each(['folder:workspace', 'remote::/checkout'])(
  'preserves creation without an active closing fence for %s',
  async (workspace) => {
    const f = fixture('offscreen')
    const pending = f.run(workspace)
    f.finish()
    await expect(pending).resolves.toEqual({ browserPageId: 'page' })
  }
)
