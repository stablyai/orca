import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getWebContentsIdByTabId: vi.fn(() => new Map<string, number>()),
  getWorktreeIdForTab: vi.fn(() => undefined as string | undefined),
  getGuestWebContentsId: vi.fn(() => null as number | null),
  webContentsFromId: vi.fn(() => null as unknown)
}))

vi.mock('electron', () => ({ webContents: { fromId: mocks.webContentsFromId } }))
vi.mock('../browser/browser-manager', () => ({
  browserManager: {
    getWebContentsIdByTabId: mocks.getWebContentsIdByTabId,
    getWorktreeIdForTab: mocks.getWorktreeIdForTab,
    getGuestWebContentsId: mocks.getGuestWebContentsId
  }
}))

import {
  waitForAnyTabRegistration,
  waitForNextTabRegistration,
  waitForWorktreeTabRegistration
} from './browser-tab-registration-wait'
import { installDocPreviewGuestPolicy } from '../browser/doc-preview-guest-policy'
import {
  mintDocPreviewGrant,
  revokeAllDocPreviewGrants
} from '../browser/doc-preview-grant-registry'
import { buildDocPreviewUrl } from '../../shared/doc-preview-scheme'

const WAIT_MS = 1_000

function attachDocumentGuest(browserPageId: string): void {
  const grant = mintDocPreviewGrant({
    owner: { kind: 'ssh', connectionId: 'ssh-1' },
    root: '/home/alice/docs',
    entryRelativePath: 'index.html',
    browserPageId
  })
  const guest = {
    isFocused: () => false,
    isDestroyed: () => false,
    getURL: () => buildDocPreviewUrl(grant.id, grant.entryRelativePath),
    on: vi.fn(),
    once: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    setWebRTCIPHandlingPolicy: vi.fn()
  }
  installDocPreviewGuestPolicy(guest as never, { id: 91, send: vi.fn() })
}

function track(pending: Promise<void>): () => 'pending' | 'resolved' | 'rejected' {
  let state: 'pending' | 'resolved' | 'rejected' = 'pending'
  pending.then(
    () => {
      state = 'resolved'
    },
    () => {
      state = 'rejected'
    }
  )
  return () => state
}

beforeEach(() => {
  revokeAllDocPreviewGrants()
  vi.clearAllMocks()
  mocks.getWebContentsIdByTabId.mockReturnValue(new Map())
  mocks.getGuestWebContentsId.mockReturnValue(null)
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a workspace document registering', () => {
  it('settles a wait that already names its page', async () => {
    const settled = track(waitForNextTabRegistration('doc-page-1', WAIT_MS))

    attachDocumentGuest('doc-page-1')
    await vi.advanceTimersByTimeAsync(0)

    expect(settled()).toBe('resolved')
  })

  // CLI/agent any-tab waits need drivable browser tabs; documents satisfy only their own page wait.
  it('leaves the waits that ask for any browser tab still waiting', async () => {
    const worktreeWait = track(waitForWorktreeTabRegistration('wt-1', WAIT_MS))
    const anyWait = track(waitForAnyTabRegistration(WAIT_MS))

    attachDocumentGuest('doc-page-2')
    await vi.advanceTimersByTimeAsync(0)

    expect(worktreeWait()).toBe('pending')
    expect(anyWait()).toBe('pending')

    // Verify unsatisfied waits actually time out.
    await vi.advanceTimersByTimeAsync(WAIT_MS)
    expect(worktreeWait()).toBe('rejected')
    expect(anyWait()).toBe('rejected')
  })
})
