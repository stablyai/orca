import { describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTerminalTab } from '../../../../shared/runtime-types'
import { projectRuntimeMobileSessionTitle } from './runtime-mobile-session-title-projection'
import { resolveTerminalTabTitle } from '../../../../shared/tab-title-resolution'

const tab: RuntimeMobileSessionTerminalTab = {
  type: 'terminal',
  id: 'tab-1::leaf-1',
  parentTabId: 'tab-1',
  leafId: 'leaf-1',
  title: 'Codex 公司 High',
  quickCommandLabel: 'Codex 公司 High',
  aiVaultTitle: { agent: 'codex', sessionId: 'session-1', title: 'Login cleanup' },
  resolvesSessionTitle: true,
  isActive: true
}

describe('paired desktop tab names', () => {
  it('sends a quick-command name with the session name so the paired desktop keeps the same order', () => {
    const projected = projectRuntimeMobileSessionTitle({ worktree: 'wt-1' }, tab, {
      isSessionTitlePublisher: () => true
    })
    expect(
      resolveTerminalTabTitle({ title: tab.title, customTitle: null, ...projected }, true)
    ).toBe('Codex 公司 High')
  })
})
