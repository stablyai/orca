import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getMobileAiVaultCacheKey,
  readMobileAiVaultCache,
  writeMobileAiVaultCache
} from '../agent-history/mobile-ai-vault-session-cache'
import { useMobileSessionCloseActions } from './use-mobile-session-close-actions'
import type { MobileSessionTab, Terminal } from './mobile-session-route-types'

describe('useMobileSessionCloseActions', () => {
  let renderer: ReactTestRenderer | undefined
  afterEach(() => renderer?.unmount())

  it('optimistically updates sessionTabs and schedules fetchSessionTabs upon terminal rename', async () => {
    const client = {
      sendRequest: vi.fn(async () => ({ ok: true, result: {} }))
    }

    const initialTerminals: Terminal[] = [
      { handle: 'term-1', title: 'Claude Code', isActive: true }
    ]
    const initialSessionTabs: MobileSessionTab[] = [
      {
        type: 'terminal',
        id: 'tab-1::pane:1',
        title: 'Claude Code',
        terminal: 'term-1',
        parentTabId: 'tab-1',
        leafId: 'pane:1',
        isActive: true
      },
      {
        type: 'terminal',
        id: 'tab-2::pane:2',
        title: 'Terminal 2',
        terminal: 'term-2',
        parentTabId: 'tab-2',
        leafId: 'pane:2',
        isActive: false
      }
    ]

    const setTerminals = vi.fn()
    const setSessionTabs = vi.fn()
    const terminalsRef = { current: initialTerminals }
    const sessionTabsRef = { current: initialSessionTabs }
    const scheduledActions: (() => void)[] = []
    const scheduleDelayedAction = vi.fn((action: () => void, _delayMs: number) => {
      scheduledActions.push(action)
    })
    const fetchTerminals = vi.fn(async () => {})
    const fetchSessionTabs = vi.fn(async () => {})
    const setRenameTarget = vi.fn()

    const scope = {
      worktreeId: 'wt-1',
      client,
      setTerminals,
      terminals: initialTerminals,
      terminalsRef,
      setSessionTabs,
      setFileDocs: vi.fn(),
      setMarkdownDocs: vi.fn(),
      sessionTabsRef,
      reconcileBufferedDraftsRef: { current: vi.fn() },
      closedTabTombstonesRef: { current: new Map() },
      clearTerminalLiveInputDefault: vi.fn(),
      setActiveHandle: vi.fn(),
      setActiveSessionTabId: vi.fn(),
      activeSessionTabIdRef: { current: 'tab-1::pane:1' },
      selectedSessionTabIdRef: { current: 'tab-1::pane:1' },
      renameTarget: { handle: 'term-1', title: 'Claude Code', isActive: true },
      setRenameTarget,
      terminalRefs: { current: new Map() },
      activeHandleRef: { current: 'term-1' },
      activeSessionTabTypeRef: { current: 'terminal' },
      pendingSelectionRef: { current: null },
      pendingBrowserFocusPageIdRef: { current: null },
      scheduleDelayedAction,
      unsubscribeTerminal: vi.fn(),
      subscribeToTerminal: vi.fn(),
      fetchTerminals,
      fetchSessionTabs
    }

    let actions: ReturnType<typeof useMobileSessionCloseActions> | undefined
    function Harness() {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test harness provides the rename slice of the session scope.
      actions = useMobileSessionCloseActions(scope as never)
      return null
    }

    await act(async () => {
      renderer = create(createElement(Harness))
    })

    const cacheKey = getMobileAiVaultCacheKey('host-1', 'wt-1', 'workspace')
    writeMobileAiVaultCache(cacheKey, {
      sessions: [],
      issues: [],
      fingerprint: 'f'.repeat(64),
      limit: 250
    })
    expect(readMobileAiVaultCache(cacheKey)).not.toBeNull()

    await act(async () => {
      await actions?.handleRenameTerminal('Auth Worker')
    })

    expect(readMobileAiVaultCache(cacheKey)).toBeNull()
    expect(client.sendRequest).toHaveBeenCalledWith('terminal.rename', {
      terminal: 'term-1',
      title: 'Auth Worker'
    })
    expect(setRenameTarget).toHaveBeenCalledWith(null)
    expect(sessionTabsRef.current).toEqual([
      expect.objectContaining({
        type: 'terminal',
        terminal: 'term-1',
        title: 'Auth Worker'
      }),
      expect.objectContaining({
        type: 'terminal',
        terminal: 'term-2',
        title: 'Terminal 2'
      })
    ])
    expect(setSessionTabs).toHaveBeenCalledWith(sessionTabsRef.current)
    expect(scheduleDelayedAction).toHaveBeenCalledWith(expect.any(Function), 300)
    await act(async () => {
      scheduledActions.forEach((action) => action())
    })
    expect(fetchTerminals).toHaveBeenCalled()
    expect(fetchSessionTabs).toHaveBeenCalled()
  })
})
