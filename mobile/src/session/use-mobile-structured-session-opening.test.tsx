import type * as OpenMobileStructuredSessionModule from './open-mobile-structured-session'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type {
  StructuredSessionOpenSource,
  StructuredSessionOpenResult
} from '../../../src/shared/open-structured-agent-session'
import { createFakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'
import { useMobileStructuredSessionOpening } from './use-mobile-structured-session-opening'
import {
  activateMobileUiLocale,
  mobileI18n,
  setMobilePseudoLocalization
} from '../i18n/mobile-i18n'
import { pseudoLocalizeString } from '../../../src/shared/pseudo-localization'
const mocks = vi.hoisted(() => ({
  executionHost: 'local',
  open: vi.fn(),
  push: vi.fn(),
  replace: vi.fn()
}))
vi.mock('../navigation/workspace-execution-host', () => ({
  useWorkspaceExecutionHost: () => mocks.executionHost
}))
vi.mock('../navigation/workspace-route-handoff', () => ({
  useWorkspaceRouteHandoff: () => ({ push: mocks.push, replace: mocks.replace })
}))
vi.mock('./open-mobile-structured-session', async (original) => ({
  ...(await original<typeof OpenMobileStructuredSessionModule>()),
  openMobileStructuredSession: mocks.open
}))
const source: StructuredSessionOpenSource = {
  kind: 'notification',
  sessionId: 'root',
  worktreeId: 'workspace'
}
const opened: StructuredSessionOpenResult = {
  kind: 'opened',
  target: { sessionId: 'live', worktreeId: 'workspace' },
  tab: { id: 'actual', sessionId: 'live', agent: 'codex' }
}
afterEach(async () => {
  vi.clearAllMocks()
  setMobilePseudoLocalization(false)
  mobileI18n.removeResourceBundle('fr', 'translation')
  await activateMobileUiLocale('en')
})
it.each(
  (['stable', 'newer-pick', 'execution-host', 'unmount'] as const).flatMap((mode) =>
    (['opened', 'failed'] as const).map((outcome) => ({ mode, outcome }))
  )
)('only the owning phone view applies $outcome completion: $mode', async ({ mode, outcome }) => {
  await activateMobileUiLocale('en')
  mocks.executionHost = 'local'
  const deferred = Promise.withResolvers<StructuredSessionOpenResult>()
  mocks.open.mockReturnValue(deferred.promise)
  const selected = { current: 'source' }
  const pending = { current: null }
  const switchSessionTab = vi.fn()
  const scope: Parameters<typeof useMobileStructuredSessionOpening>[0] = {
    hostId: 'host',
    worktreeId: 'workspace',
    client: createFakeRpcClient(),
    connState: 'connected',
    showToast: vi.fn(),
    switchSessionTab,
    activeSessionTabIdRef: { current: 'source' },
    selectedSessionTabIdRef: selected,
    pendingSelectionRef: pending,
    sessionTabsRef: {
      current: [
        {
          type: 'terminal',
          id: 'source',
          title: 'Source',
          terminal: 'terminal-source',
          isActive: true
        }
      ]
    }
  }
  let open: ((source: StructuredSessionOpenSource) => Promise<void>) | undefined
  function Probe() {
    open = useMobileStructuredSessionOpening(scope)
    return null
  }
  let tree: ReactTestRenderer | undefined
  await act(async () => {
    tree = create(createElement(Probe))
  })
  try {
    let completion: Promise<void> | undefined
    await act(async () => {
      completion = open?.(
        outcome === 'opened'
          ? source
          : {
              kind: 'sender',
              party: { address: 'orca_session_id:root', terminalHandle: null, orcaSessionId: null },
              messageIds: ['message'],
              fallback: { sessionId: 'root', worktreeId: 'workspace', agent: 'codex' },
              displayName: 'Worker custom'
            }
      )
    })
    if (mode === 'newer-pick') {
      selected.current = 'newer-user-pick'
    }
    if (mode === 'execution-host') {
      mocks.executionHost = 'ssh:another'
      await act(async () => tree?.update(createElement(Probe)))
    }
    if (mode === 'unmount') {
      await act(async () => tree?.unmount())
    }
    mobileI18n.addResourceBundle('fr', 'translation', {
      'session.structuredOpen.unreachable': 'Conversation de {{agent}} : réessayez.'
    })
    await activateMobileUiLocale('fr')
    setMobilePseudoLocalization(true)
    await act(async () => {
      deferred.resolve(
        outcome === 'opened'
          ? opened
          : {
              kind: 'failed',
              failure: { reason: 'unreachable', beforeEffects: false }
            }
      )
      await completion
    })
    expect(switchSessionTab).toHaveBeenCalledTimes(
      mode === 'stable' && outcome === 'opened' ? 1 : 0
    )
    expect(scope.showToast).toHaveBeenCalledTimes(mode === 'stable' && outcome === 'failed' ? 1 : 0)
    expect(mocks.push).not.toHaveBeenCalled()
    if (mode === 'stable' && outcome === 'failed') {
      expect(scope.showToast).toHaveBeenCalledWith(
        pseudoLocalizeString('Conversation de Worker custom : réessayez.', { expand: true }),
        3_000
      )
      expect(mocks.open).toHaveBeenCalledWith(
        expect.objectContaining({
          source: expect.objectContaining({
            fallback: { sessionId: 'root', worktreeId: 'workspace', agent: 'codex' }
          })
        })
      )
    }
    if (mode === 'stable' && outcome === 'opened') {
      expect(switchSessionTab).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'actual', sessionId: 'live' }),
        { activate: false }
      )
    }
  } finally {
    await act(async () => tree?.unmount())
  }
})

it('routes a removed workspace notification to the existing host notice without a tab or duplicate toast', async () => {
  mocks.executionHost = 'local'
  mocks.open.mockResolvedValue({
    kind: 'failed',
    failure: { reason: 'workspace-missing', beforeEffects: true }
  })
  const scope: Parameters<typeof useMobileStructuredSessionOpening>[0] = {
    hostId: 'host',
    worktreeId: 'workspace',
    client: createFakeRpcClient(),
    connState: 'connected',
    showToast: vi.fn(),
    switchSessionTab: vi.fn(),
    activeSessionTabIdRef: { current: null },
    selectedSessionTabIdRef: { current: null },
    pendingSelectionRef: { current: null },
    sessionTabsRef: { current: [] }
  }
  let open: ((value: StructuredSessionOpenSource) => Promise<void>) | undefined
  function Probe() {
    open = useMobileStructuredSessionOpening(scope)
    return null
  }
  let tree: ReactTestRenderer | undefined
  try {
    await act(async () => {
      tree = create(createElement(Probe))
    })
    await act(async () => {
      await open?.(source)
    })
    expect(mocks.replace).toHaveBeenCalledExactlyOnceWith('/h/host?notice=worktree-missing')
    expect(mocks.push).not.toHaveBeenCalled()
    expect(scope.switchSessionTab).not.toHaveBeenCalled()
    expect(scope.showToast).not.toHaveBeenCalled()
  } finally {
    await act(async () => tree?.unmount())
  }
})
