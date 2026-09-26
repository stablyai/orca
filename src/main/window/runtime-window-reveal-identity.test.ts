// A reveal reply attests which pane the renderer actually bound. Ownership is tab-keyed, so the
// renderer decides which workspace key holds the row; re-asserting the caller's key here rejected
// a reveal that had surfaced exactly the right pane under a different one (STA-7961).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  revealedPaneMatches,
  type TerminalTabCreateReply
} from '../../shared/terminal-reveal-identity'

let lastWebContents: unknown = null
const sentByChannel: [string, ...unknown[]][] = []

const { ipcMainOnMock, ipcMainRemoveListenerMock } = vi.hoisted(() => ({
  ipcMainOnMock: vi.fn(),
  ipcMainRemoveListenerMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { on: ipcMainOnMock, removeListener: ipcMainRemoveListenerMock }
}))
vi.mock('../ipc/worktree-change-invalidators', () => ({ runWorktreeChangeInvalidators: vi.fn() }))
vi.mock('./mobile-markdown-request-relay', () => ({
  requestMobileMarkdownFromRenderer: vi.fn()
}))
vi.mock('./renderer-document-navigation', () => ({
  registerRendererDocumentNavigation: vi.fn()
}))
vi.mock('./session-tab-close-request-relay', () => ({
  requestSessionTabCloseFromRenderer: vi.fn()
}))
vi.mock('./terminal-tab-close-request-relay', () => ({
  requestTerminalTabCloseFromRenderer: vi.fn()
}))
// Captures the stub webContents the most recent registration created.
vi.mock('./runtime-renderer-notification-sender', () => ({
  createRuntimeRendererNotificationSender: (args: { webContents: unknown }) => {
    lastWebContents = args.webContents
    return {
      send: (channel: string, ...values: unknown[]) => {
        sentByChannel.push([channel, ...values])
        return true
      },
      onMainFrameReloadStarted: vi.fn(),
      onMainFrameReloadCancelled: vi.fn(),
      onMainFrameLoadFinished: vi.fn(),
      onRendererProcessGone: vi.fn(),
      close: vi.fn()
    }
  }
}))

import { registerRuntimeWindowLifecycle } from './runtime-window-lifecycle'

const CALLER_WORKTREE_ID = 'repo::/worktree'
const OWNER_WORKTREE_ID = 'repo::/other-worktree'

type RevealNotifier = {
  revealTerminalSession: (
    worktreeId: string,
    opts: Record<string, unknown>
  ) => Promise<{ tabId: string }>
}

/** Registers the lifecycle against stub window/runtime objects and hands back its notifier. */
function attachNotifier(): RevealNotifier {
  let notifier: RevealNotifier | null = null
  const webContents = { isDestroyed: () => false, send: vi.fn(() => true), on: vi.fn() }
  const mainWindow = { id: 1, isDestroyed: () => false, webContents, on: vi.fn() }
  const runtime = {
    attachWindow: vi.fn(),
    setNotifier: vi.fn((next: RevealNotifier | null) => {
      notifier = next ?? notifier
    }),
    markGraphReloadFailed: vi.fn(),
    markGraphUnavailable: vi.fn(),
    markRendererReloading: vi.fn(),
    markRendererReloadCancelled: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stubs above cover every member registerRuntimeWindowLifecycle touches; the rest of BrowserWindow/OrcaRuntimeService is unreachable from this call.
  registerRuntimeWindowLifecycle(mainWindow as never, runtime as never)
  if (!notifier) {
    throw new Error('Expected registerRuntimeWindowLifecycle to install a notifier')
  }
  return notifier
}

/** Fires the reply the renderer would send, using the requestId the reveal generated. */
function replyToReveal(reply: Omit<TerminalTabCreateReply, 'requestId'>): void {
  const registered = ipcMainOnMock.mock.calls.at(-1)
  expect(registered?.[0]).toBe('terminal:tabCreateReply')
  const handler = registered?.[1]
  if (typeof handler !== 'function') {
    throw new Error('Expected a terminal:tabCreateReply listener')
  }
  const listener: (event: { sender: unknown }, reply: TerminalTabCreateReply) => void = handler
  listener(
    { sender: lastWebContents },
    { requestId: sentCreateTerminalPayload().requestId, ...reply }
  )
}

function sentCreateTerminalPayload(): { requestId: string; worktreeId: string } {
  const payload = sentByChannel.findLast(([channel]) => channel === 'ui:createTerminal')?.[1]
  if (!isCreateTerminalPayload(payload)) {
    throw new Error('Expected the reveal to send a ui:createTerminal payload')
  }
  return payload
}

function isCreateTerminalPayload(
  value: unknown
): value is { requestId: string; worktreeId: string } {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  return (
    'requestId' in value &&
    typeof value.requestId === 'string' &&
    'worktreeId' in value &&
    typeof value.worktreeId === 'string'
  )
}

function startReveal(): Promise<{ tabId: string }> {
  const notifier = attachNotifier()
  return notifier.revealTerminalSession(CALLER_WORKTREE_ID, {
    ptyId: 'pty-a',
    tabId: 'tab-a',
    leafId: 'leaf-a',
    expectedProcessIdentity: { terminalHandle: 'handle-1', incarnationId: 'inc-1' }
  })
}

beforeEach(() => {
  ipcMainOnMock.mockClear()
  ipcMainRemoveListenerMock.mockClear()
  sentByChannel.length = 0
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('revealTerminalSession identity assertion', () => {
  it('resolves when the renderer files the pane under a different worktree key', async () => {
    const reveal = startReveal()

    replyToReveal({
      tabId: 'tab-a',
      identity: {
        worktreeId: OWNER_WORKTREE_ID,
        tabId: 'tab-a',
        leafId: 'leaf-a',
        ptyId: 'pty-a'
      }
    })

    await expect(reveal).resolves.toMatchObject({
      tabId: 'tab-a',
      identity: { worktreeId: OWNER_WORKTREE_ID }
    })
  })

  it.each([
    ['tabId', { tabId: 'tab-other' }],
    ['leafId', { leafId: 'leaf-other' }],
    ['ptyId', { ptyId: 'pty-other' }]
  ])('still rejects when the reply disagrees on %s', async (_field, override) => {
    const reveal = startReveal()

    replyToReveal({
      tabId: 'tab-a',
      identity: {
        worktreeId: CALLER_WORKTREE_ID,
        tabId: 'tab-a',
        leafId: 'leaf-a',
        ptyId: 'pty-a',
        ...override
      }
    })

    await expect(reveal).rejects.toThrow('terminal_reveal_identity_mismatch')
  })

  it('still passes the caller worktree to the renderer as the hint to look under first', () => {
    void startReveal().catch(() => {})

    expect(sentCreateTerminalPayload().worktreeId).toBe(CALLER_WORKTREE_ID)
  })
})

describe('revealedPaneMatches', () => {
  const candidate = { tabId: 'tab-a', leafId: 'leaf-a', ptyId: 'pty-a' }

  it('accepts a reveal filed under another worktree key', () => {
    // Without this the recovery rolled the surface back and the worker never materialized.
    expect(revealedPaneMatches({ worktreeId: OWNER_WORKTREE_ID, ...candidate }, candidate)).toBe(
      true
    )
  })

  it('refuses a reply that names a different pane', () => {
    expect(
      revealedPaneMatches(
        { worktreeId: CALLER_WORKTREE_ID, ...candidate, leafId: 'leaf-other' },
        candidate
      )
    ).toBe(false)
  })

  it('refuses a reply with no identity at all', () => {
    expect(revealedPaneMatches(undefined, candidate)).toBe(false)
  })
})
