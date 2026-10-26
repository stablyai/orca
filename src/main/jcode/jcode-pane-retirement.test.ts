import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../agent-hooks/server'
import { PANE } from '../agent-hooks/server.test-fixtures'
import {
  childPane,
  displayRootId,
  displayWorkerId,
  movedPane,
  throwawayId
} from '../../shared/agent-hook-listener-jcode-display-fixtures'
import { bindJcodeRootSession } from '../../shared/agent-hook-listener/jcode-session-registry'
import { RuntimeExternalParentLinks } from '../runtime/runtime-external-parent-links'
import {
  forgetJcodePaneSecret,
  mintJcodePaneSecret,
  verifyJcodePaneSecret
} from './jcode-pane-secrets'
import { retireJcodePane } from './jcode-pane-retirement'

function harness() {
  const server = new AgentHookServer()
  bindJcodeRootSession(server._getStateForTests(), PANE, displayRootId, 'launch')
  const secret = mintJcodePaneSecret(PANE)
  const links = new RuntimeExternalParentLinks()
  const handles = new Map<string, string>([
    [childPane, 'child-a'],
    [movedPane, 'child-b']
  ])
  const runtime = {
    getTerminalHandleForPaneKey: (key: string) => handles.get(key) ?? null,
    closeTerminalTab: vi.fn(async (_handle: string) => {}),
    clearExternalAgentParentLink: (key: string) => links.delete(key)
  }
  // Negative control: bind the captured throwaway as a second visible worker.
  for (const [key, sessionId] of [
    [childPane, displayWorkerId],
    [movedPane, throwawayId]
  ]) {
    expect(
      server.reserveJcodeSessionTab({ sessionId, paneKey: key, rootPaneKey: PANE, kind: 'worker' })
    ).toEqual({ ok: true })
    expect(
      server.bindJcodeDisplaySession({
        rootPaneKey: PANE,
        displayPaneKey: key,
        sessionId,
        coordinatorSessionId: displayRootId,
        tabId: key.split(':')[0],
        state: 'open',
        boundAt: Date.now()
      })
    ).toBe(true)
    expect(server.confirmJcodeSessionTab(sessionId, key)).toBe(true)
    links.set(key, { parentPaneKey: PANE, taskId: sessionId })
  }
  return { server, runtime, links, secret, forgetJcodePaneSecret, isQuitting: () => false }
}

afterEach(() => {
  for (const key of [PANE, childPane, movedPane]) {
    forgetJcodePaneSecret(key)
  }
  vi.restoreAllMocks()
})

describe('Jcode pane retirement', () => {
  it('leaves panes without Jcode state untouched beyond reads', () => {
    const h = harness()
    const mutations = [
      vi.spyOn(h.server, 'clearPaneState'),
      vi.spyOn(h.server, 'clearJcodeDisplayBindingsOfRoot'),
      vi.spyOn(h.server, 'closeJcodeSessionTab'),
      vi.spyOn(h.server, 'settleJcodeDisplayPane')
    ]
    retireJcodePane(h, 'unmanaged:11111111-1111-4111-8111-111111111111')
    for (const mutation of mutations) {
      expect(mutation).not.toHaveBeenCalled()
    }
    expect(h.runtime.closeTerminalTab).not.toHaveBeenCalled()
  })

  it('retires both workers once, removes links and fences root authority', () => {
    const h = harness()
    retireJcodePane(h, PANE)
    retireJcodePane(h, PANE)
    expect(h.runtime.closeTerminalTab.mock.calls).toEqual([['child-a'], ['child-b']])
    expect(h.links.entries()).toEqual([])
    expect(verifyJcodePaneSecret(PANE, h.secret)).toBe(false)
    expect(h.server.jcodeDisplayPanesOfRoot(PANE)).toEqual([])
    expect(h.server._getStateForTests().jcodeDisplayBindings.size).toBe(0)
  })

  it('keeps worker tabs during quit while releasing all Jcode state', () => {
    const h = harness()
    retireJcodePane({ ...h, isQuitting: () => true }, PANE)
    expect(h.runtime.closeTerminalTab).not.toHaveBeenCalled()
    expect(h.links.entries()).toEqual([])
    expect(verifyJcodePaneSecret(PANE, h.secret)).toBe(false)
    expect(h.server._getStateForTests().jcodeTabOwners.size).toBe(0)
    expect(h.server._getStateForTests().jcodeDisplayBindings.size).toBe(0)
    expect(h.server.rootJcodeSessionId(PANE)).toBeUndefined()
  })

  it('settles one child without closing root or sibling, keeping only routing tombstone', () => {
    const h = harness()
    retireJcodePane(h, childPane)
    retireJcodePane(h, childPane)
    expect(h.runtime.closeTerminalTab).not.toHaveBeenCalled()
    expect(h.server.findJcodeSessionOwner(displayWorkerId)).toBeUndefined()
    expect(h.server.rootJcodeSessionId(PANE)).toBe(displayRootId)
    expect(h.server.jcodeDisplayPanesOfRoot(PANE)).toEqual([movedPane])
    expect(h.links.entries().map(([key]) => key)).toEqual([movedPane])
    const state = h.server._getStateForTests()
    expect(
      [...state.jcodeDisplayBindings.values()].find((b) => b.displayPaneKey === childPane)?.state
    ).toBe('closed')
    expect(state.jcodeSessions.roots.has(childPane)).toBe(false)
    expect(
      [...state.jcodeSessions.tombstones.keys()].some((key) => key.startsWith(`${childPane}\0`))
    ).toBe(false)
    expect(verifyJcodePaneSecret(PANE, h.secret)).toBe(true)
  })

  it.each(['throw', 'reject'] as const)(
    'continues after close %s without exposing error text',
    async (mode) => {
      const h = harness()
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
      h.runtime.closeTerminalTab.mockImplementationOnce(() => {
        if (mode === 'throw') {
          throw new Error('private failure detail')
        }
        return Promise.reject(new Error('private failure detail'))
      })
      retireJcodePane(h, PANE)
      await Promise.resolve()
      expect(h.runtime.closeTerminalTab.mock.calls).toEqual([['child-a'], ['child-b']])
      expect(h.links.entries()).toEqual([])
      expect(h.server.jcodeDisplayPanesOfRoot(PANE)).toEqual([])
      expect(verifyJcodePaneSecret(PANE, h.secret)).toBe(false)
      expect(warning).toHaveBeenCalledWith('[jcode-spawn] Pane cleanup failed: close child')
      expect(warning.mock.calls.flat().join(' ')).not.toContain('private failure detail')
    }
  )
})
