// Confirmed pinned-tab closes carry force and advertise that capability in both layout builds.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SESSION_TAB_CLOSE_FORCE_RUNTIME_CAPABILITY } from '../../shared/session-tabs-runtime-capabilities'
import { SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import { z } from 'zod'
import { OrcaRuntimeService } from './orca-runtime'
import { RpcDispatcher } from './rpc/dispatcher'
import { SESSION_TAB_METHODS } from './rpc/methods/session-tabs'
import {
  ACK_TAB,
  ACK_WORKTREE,
  createAcknowledgedTabRetirementFixture
} from './acknowledged-terminal-tab-retirement-fixture'

// Read at each close, so one import serves both builds.
const layoutOwner = vi.hoisted(() => ({ isMain: false }))
vi.mock('../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return layoutOwner.isMain
  }
}))

const Reply = z.object({ ok: z.boolean(), error: z.object({ code: z.string() }).optional() })

const disposers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of disposers.splice(0)) {
    await dispose()
  }
  vi.restoreAllMocks()
  layoutOwner.isMain = false
})

async function pinnedServerTab(layoutOwnerIsMain: boolean) {
  layoutOwner.isMain = layoutOwnerIsMain
  const f = createAcknowledgedTabRetirementFixture(true)
  disposers.push(() => f.dispose())
  const stopped: string[] = []
  f.runtime.setPtyController({
    write: () => true,
    kill: (ptyId: string) => {
      stopped.push(ptyId)
      return true
    },
    getForegroundProcess: async () => null
  })
  const session = f.store.getWorkspaceSession()
  f.store.setWorkspaceSession({
    ...session,
    tabsByWorktree: {
      ...session.tabsByWorktree,
      [ACK_WORKTREE]: session.tabsByWorktree[ACK_WORKTREE].map((tab) => ({
        ...tab,
        isPinned: true
      }))
    }
  })
  // Model the window pin guard: pinned tabs require force.
  const windowClose = f.closeTerminalTab.getMockImplementation()!
  f.acknowledgement.resolve()
  f.closeTerminalTab.mockImplementation(async (_tabId?: unknown, options?: unknown) => {
    if (!(typeof options === 'object' && options !== null && 'force' in options && options.force)) {
      throw new Error('terminal_tab_pinned')
    }
    await windowClose()
  })
  const dispatcher = new RpcDispatcher({
    runtime: f.runtime,
    methods: SESSION_TAB_METHODS
  })
  const close = async (
    params: Record<string, unknown>,
    clientCapabilities: string[] = [SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY]
  ): Promise<z.infer<typeof Reply>> => {
    let reply: z.infer<typeof Reply> | undefined
    await dispatcher.dispatchStreaming(
      {
        id: 'close-1',
        authToken: 'unused',
        method: 'session.tabs.close',
        params: { worktree: `id:${ACK_WORKTREE}`, tabId: ACK_TAB, reason: 'user', ...params }
      },
      (raw) => {
        reply = Reply.parse(JSON.parse(raw))
      },
      {
        clientKind: 'runtime',
        pairedDeviceId: 'paired-desktop',
        clientCapabilities
      }
    )
    return reply!
  }
  return { f, stopped, close }
}

describe.each([false, true])('ORCA_LAYOUT_OWNER_IS_MAIN=%s', (layoutOwnerIsMain) => {
  it('advertises the forced-close capability', async () => {
    layoutOwner.isMain = layoutOwnerIsMain
    expect(new OrcaRuntimeService().getStatus().capabilities).toContain(
      SESSION_TAB_CLOSE_FORCE_RUNTIME_CAPABILITY
    )
  })

  it('refuses an unforced close of a pinned tab and keeps it and its terminals', async () => {
    const { f, stopped, close } = await pinnedServerTab(layoutOwnerIsMain)
    const reply = await close({})
    expect(reply.error?.code).toBe('terminal_tab_pinned')
    expect(f.hasTab()).toBe(true)
    expect(stopped).toEqual([])
  })

  it('closes a pinned tab on a confirmed (forced) close and stops its terminals', async () => {
    const { f, stopped, close } = await pinnedServerTab(layoutOwnerIsMain)
    const reply = await close({ force: true })
    expect(reply.ok).toBe(true)
    expect(f.hasTab()).toBe(false)
    if (layoutOwnerIsMain) {
      expect(stopped).toEqual(expect.arrayContaining(['pty-a', 'pty-b']))
    } else {
      // The window's forced close stops the tab's terminals there.
      expect(f.closeTerminalTab).toHaveBeenCalledWith(expect.any(String), { force: true })
    }
  })

  it('closes a pinned tab on a replayed confirmed close, which a newer client marks as replay', async () => {
    const { f, close } = await pinnedServerTab(layoutOwnerIsMain)
    const reply = await close({ reason: 'replay', force: true })
    expect(reply.ok).toBe(true)
    expect(f.hasTab()).toBe(false)
  })

  it('ignores force on a reasonless legacy close, which never carried a confirmation', async () => {
    const { f, close } = await pinnedServerTab(layoutOwnerIsMain)
    const reply = await close({ reason: undefined, force: true }, [])
    expect(reply.error?.code).toBe('terminal_tab_pinned')
    expect(f.hasTab()).toBe(true)
  })
})
