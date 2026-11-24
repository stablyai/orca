import { describe, expect, it, vi } from 'vitest'
import { createStructuredAgentSessionTabSurface } from './structured-agent-session-host-tabs'
import { onStructuredSessionTabsShown } from './structured-session-tabs-shown'

function surface() {
  const store = { showSessionTabs: vi.fn(async () => 'shown') }
  const publishStatus = vi.fn()
  const warn = vi.fn()
  const host = {
    deps: { logger: { warn }, store },
    restartResume: { dismiss: vi.fn(async () => 0) }
  }
  const tabs = createStructuredAgentSessionTabSurface(
    host as never,
    new Map(),
    { publishStatus } as never,
    async () => {}
  )
  return { tabs, store, publishStatus, warn }
}

describe('showSessionTabs', () => {
  it('shows the tabs, publishes each status and tells the runtime which chats came back', async () => {
    const shown = vi.fn()
    const stop = onStructuredSessionTabsShown(shown)
    const { tabs, store, publishStatus } = surface()
    await expect(tabs.showSessionTabs(['b', 'a'])).resolves.toBe('shown')
    expect(store.showSessionTabs).toHaveBeenCalledWith(['b', 'a'])
    expect(publishStatus).toHaveBeenCalledTimes(2)
    expect(shown).toHaveBeenCalledWith(['b', 'a'])
    stop()
  })

  it('a failing listener is logged and never fails the show', async () => {
    const stop = onStructuredSessionTabsShown(() => {
      throw new Error('boom')
    })
    const { tabs, warn } = surface()
    await expect(tabs.showSessionTabs(['a'])).resolves.toBe('shown')
    expect(warn).toHaveBeenCalled()
    stop()
  })
})
