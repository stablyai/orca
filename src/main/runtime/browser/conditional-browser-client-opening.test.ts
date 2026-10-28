import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { tryAcquireConditionalWorktreeRemoval } from '../../ipc/conditional-worktree-removal-lease'
import type { BrowserHostLeaseRegistry } from '../browser-host/browser-host-lease-registry'
import { RuntimeBrowserPageRegistry } from '../runtime-browser-page-registry'
import {
  openBrowserUrlOnClient,
  type BrowserClientPageOpeningHost
} from './browser-client-page-opening'

const mocks = vi.hoisted(() => ({ create: vi.fn(), navigate: vi.fn(async () => {}) }))
vi.mock('../runtime-browser-client-page-creation', () => ({
  createRuntimeBrowserClientPage: mocks.create,
  navigateRuntimeBrowserClientPage: mocks.navigate
}))

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-browser-open-admission-'))
})
afterEach(async () => {
  vi.clearAllMocks()
  await rm(root, { recursive: true, force: true })
})

function fixture() {
  let finish: (() => void) | undefined
  const pending = new Promise<void>((resolve) => {
    finish = resolve
  })
  const placement = {
    kind: 'client' as const,
    browserHostClientId: 'host',
    browserHostGeneration: 1,
    pageHostGeneration: 1
  }
  mocks.create.mockImplementation(async () => {
    await pending
    return { browserPageId: 'page', placement }
  })
  const pages = new RuntimeBrowserPageRegistry()
  const resolveWorkspace = vi.fn(async (id: string) => ({ id }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: page creation is mocked; paired-host selection reads only select.
  const authority = {
    select: () => ({ browserHostClientId: 'host', pairedDeviceId: 'device' })
  } as unknown as BrowserHostLeaseRegistry
  const host: BrowserClientPageOpeningHost = {
    getAgentBrowserBridge: () => null,
    resolveBrowserWorkspace: resolveWorkspace,
    resolveBrowserNetworkExecutionHost: () => ({
      kind: 'native',
      runtimeId: 'runtime',
      revision: 1
    }),
    getBrowserHostLeaseRegistry: () => authority,
    getRuntimeBrowserPageRegistry: () => pages,
    notifyHeadlessBrowserSessionTabsChanged: () => {
      expect(tryAcquireConditionalWorktreeRemoval(root)).toEqual({ kind: 'busy' })
    }
  }
  return { host, pages, resolveWorkspace, finish: () => finish?.() }
}

it('keeps openUrl admitted until the created client page is published', async () => {
  const f = fixture()
  const pending = openBrowserUrlOnClient(f.host, {
    url: 'https://example.invalid/',
    worktree: `repo::${root}`
  })
  expect(tryAcquireConditionalWorktreeRemoval(root)).toEqual({ kind: 'busy' })
  f.finish()
  const created = await pending
  expect(f.pages.getPage(created.browserPageId)).toMatchObject({
    workspaceId: `repo::${root}`,
    loading: false
  })
  const admission = tryAcquireConditionalWorktreeRemoval(root)
  expect(admission.kind).toBe('acquired')
  if (admission.kind === 'acquired') {
    admission.release()
  }
})

it('refuses openUrl before workspace resolution or a create command', () => {
  const f = fixture()
  const admission = tryAcquireConditionalWorktreeRemoval(root)
  if (admission.kind !== 'acquired') {
    throw new Error('Expected closing admission')
  }
  try {
    expect(() =>
      openBrowserUrlOnClient(f.host, { url: 'https://example.invalid/', worktree: `repo::${root}` })
    ).toThrow('removal is in progress')
    expect(f.resolveWorkspace).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
    expect(f.pages.listPages()).toEqual([])
  } finally {
    admission.release()
  }
})
