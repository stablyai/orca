import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { RuntimeNotifier } from './runtime-notifier-contract'
import type { TerminalPaneRevealTarget } from '../../shared/terminal-pane-reveal'

const target: TerminalPaneRevealTarget = {
  worktreeId: 'repo-1::/srv/app',
  tabId: 'tab-1',
  leafId: null,
  executionHostId: 'runtime:env-1'
}

function notifierWith(revealTerminalPane: RuntimeNotifier['revealTerminalPane']): RuntimeNotifier {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: revealTerminalPane reads only this member of the notifier.
  return { revealTerminalPane } as RuntimeNotifier
}

describe('OrcaRuntimeService.revealTerminalPane', () => {
  it('refuses on a runtime with no window, such as orca serve', async () => {
    const runtime = new OrcaRuntimeService()

    await expect(runtime.revealTerminalPane(target)).rejects.toThrow('renderer_unavailable')
  })

  it("reports the window's answer for the pane it was asked to show", async () => {
    const runtime = new OrcaRuntimeService()
    const revealTerminalPane = vi.fn(async () => false)
    runtime.setNotifier(notifierWith(revealTerminalPane))

    await expect(runtime.revealTerminalPane(target)).resolves.toEqual({
      ...target,
      navigated: false
    })
    expect(revealTerminalPane).toHaveBeenCalledWith(target)

    revealTerminalPane.mockResolvedValueOnce(true)
    await expect(runtime.revealTerminalPane(target)).resolves.toMatchObject({ navigated: true })
  })
})
