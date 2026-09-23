import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import { fetchBoundClaudeHomeUsage } from '../../rate-limits/claude-bound-home-usage'
import { setClaudeHomeBindingChangeNotifier } from '../../rate-limits/claude-home-binding-change-notification'
import { RateLimitService } from '../../rate-limits/service'
import { deferred, okProvider } from '../../rate-limits/rate-limit-service-test-harness'
import type { BoundClaudeHomeUsageResult } from '../../rate-limits/claude-bound-home-usage'
import type { RateLimitState } from '../../../shared/rate-limit-types'
import type { Store } from '../../persistence'
import { registerProjectGroupHandlers } from './project-group-handlers'

vi.mock('../../rate-limits/claude-bound-home-usage', () => ({
  fetchBoundClaudeHomeUsage: vi.fn()
}))

vi.mock('./repos-changed-notification', () => ({
  notifyReposChanged: vi.fn()
}))

const handlers = new Map<string, (event: unknown, args: unknown) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (event: unknown, args: unknown) => unknown) => {
      handlers.set(channel, handler)
    })
  }
}))

/**
 * Why this drives the IPC handler rather than `RuntimeProjectGroupController`: a plain local Orca —
 * the only configuration that renders bound-group rows at all — sends group edits through
 * `projectGroups:update` / `projectGroups:delete`, which call the store directly. Asserting the
 * controller evicts says nothing about the path these rows actually take.
 */
function wireLocalGroupIpc(): {
  service: RateLimitService
  bindings: { groupId: string; configDir: string }[]
  invoke: (channel: string, args: unknown) => unknown
} {
  const bindings = [{ groupId: 'group-a', configDir: '/tmp/home-a' }]
  const service = new RateLimitService()
  service.setBoundClaudeHomesResolver(() => bindings)
  setClaudeHomeBindingChangeNotifier((groupId) => service.evictBoundClaudeHomeUsage(groupId))

  const storeMethods = {
    getProjectGroups: () => [],
    createProjectGroup: vi.fn(),
    updateProjectGroup: vi.fn(() => ({ id: 'group-a' })),
    deleteProjectGroup: vi.fn(() => true),
    moveProjectToGroup: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the project-group handlers read only these five store methods, so no other Store member is reachable from this test.
  const store = storeMethods as unknown as Store
  const windowStub = {}
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers only pass the window to notifyReposChanged, which is mocked out in this file and ignores it.
  const mainWindow = windowStub as unknown as BrowserWindow
  registerProjectGroupHandlers(mainWindow, store)

  return {
    service,
    bindings,
    invoke: (channel, args) => handlers.get(channel)?.(null, args)
  }
}

describe('bound Claude home eviction on the local project-group IPC path', () => {
  beforeEach(() => {
    handlers.clear()
    vi.mocked(ipcMain.handle).mockClear()
    vi.mocked(fetchBoundClaudeHomeUsage).mockReset()
    setClaudeHomeBindingChangeNotifier(() => undefined)
  })

  /**
   * Why the assertion is on the pushed state and not on `getState()`: `getState()` rebuilds the
   * array from the live resolver on every call, so it hides a missing eviction entirely. What the
   * user sees is the last state that was *pushed* — with no eviction nothing pushes, and the menu
   * keeps rendering the previous directory's bars under the group's name.
   */
  async function seedOneFetchedRow(): Promise<
    ReturnType<typeof wireLocalGroupIpc> & {
      pushed: RateLimitState[]
    }
  > {
    const wiring = wireLocalGroupIpc()
    vi.mocked(fetchBoundClaudeHomeUsage).mockResolvedValue({
      status: 'ok',
      rateLimits: okProvider('claude', 40)
    })
    await wiring.service.fetchBoundClaudeHomesOnOpen()
    expect(wiring.service.getState().boundClaudeHomes?.[0]?.rateLimits?.session?.usedPercent).toBe(
      40
    )
    const pushed: RateLimitState[] = []
    wiring.service.onStateChange((state) => pushed.push(state))
    return { ...wiring, pushed }
  }

  it('pushes a row-free state when projectGroups:update rebinds the config dir', async () => {
    const { bindings, invoke, pushed } = await seedOneFetchedRow()

    bindings[0] = { groupId: 'group-a', configDir: '/tmp/home-personal' }
    invoke('projectGroups:update', {
      groupId: 'group-a',
      updates: { claudeConfigDir: '/tmp/home-personal' }
    })

    expect(pushed).toHaveLength(1)
    expect(pushed[0]?.boundClaudeHomes).toEqual([])
  })

  it('pushes a row-free state when projectGroups:delete removes the group', async () => {
    const { bindings, invoke, pushed } = await seedOneFetchedRow()

    bindings.length = 0
    invoke('projectGroups:delete', { groupId: 'group-a' })

    expect(pushed).toHaveLength(1)
    expect(pushed[0]?.boundClaudeHomes).toEqual([])
  })

  it('bumps the generation so an in-flight fetch cannot write a stale row afterwards', async () => {
    const { service, bindings, invoke } = wireLocalGroupIpc()
    const pending = deferred<BoundClaudeHomeUsageResult>()
    vi.mocked(fetchBoundClaudeHomeUsage).mockReturnValueOnce(pending.promise)

    const inFlight = service.fetchBoundClaudeHomesOnOpen()
    await Promise.resolve()

    // The binding is rebound and then restored while the fetch is still out, so the live-resolver
    // comparison sees nothing wrong; only the generation the IPC handler bumped catches it.
    invoke('projectGroups:update', {
      groupId: 'group-a',
      updates: { claudeConfigDir: '/tmp/home-personal' }
    })
    bindings[0] = { groupId: 'group-a', configDir: '/tmp/home-a' }
    pending.resolve({ status: 'ok', rateLimits: okProvider('claude', 88) })
    await inFlight

    expect(service.getState().boundClaudeHomes).toEqual([])
  })

  it('leaves the cached row alone when an update does not touch the binding', async () => {
    const { invoke, pushed } = await seedOneFetchedRow()

    invoke('projectGroups:update', { groupId: 'group-a', updates: { name: 'Renamed' } })

    expect(pushed).toEqual([])
  })
})
