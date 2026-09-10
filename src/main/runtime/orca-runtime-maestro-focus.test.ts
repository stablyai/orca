import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

describe('headless Maestro workspace tab focus', () => {
  it('acknowledges the exact Browser tab only after headless activation selects it', async () => {
    const activateMobileSessionTab = vi.fn().mockResolvedValue({
      activeTabId: 'browser-unified-1'
    })
    const runtime = {
      notifier: undefined,
      activateMobileSessionTab
    }

    await expect(
      OrcaRuntimeService.prototype.commandMaestroWorkspaceTab.call(runtime, {
        kind: 'focus',
        worktreeId: 'workspace-1',
        tabId: 'browser-unified-1'
      })
    ).resolves.toEqual({ tabId: 'browser-unified-1' })
    expect(activateMobileSessionTab).toHaveBeenCalledWith('id:workspace-1', 'browser-unified-1')
  })
})
