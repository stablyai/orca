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
  aiVaultTitle: { agent: 'codex', sessionId: 'session-1', title: 'Login cleanup', kind: 'named' },
  resolvesSessionTitle: true,
  isActive: true
}

describe('paired desktop tab names', () => {
  it('sends a quick-command name with the session name so the paired desktop keeps the same order', () => {
    const projected = projectRuntimeMobileSessionTitle({ worktree: 'wt-1' }, tab, {
      isSessionTitlePublisher: () => true
    })
    const resolve = (overrides: Partial<Parameters<typeof resolveTerminalTabTitle>[0]>) =>
      resolveTerminalTabTitle(
        { title: tab.title, customTitle: null, ...projected, ...overrides },
        true
      )
    // The session's own name replaces the quick-command name; a name typed on the tab beats both.
    expect(resolve({})).toBe('Login cleanup')
    expect(resolve({ aiVaultTitle: undefined })).toBe('Codex 公司 High')
    expect(resolve({ customTitle: 'My tab' })).toBe('My tab')
    // A first-prompt stand-in, or a title from a host that does not say its kind, keeps the quick-command name.
    const prompt = { agent: 'codex' as const, sessionId: 'session-1', title: 'fix the login page' }
    expect(resolve({ aiVaultTitle: { ...prompt, kind: 'fallback' } })).toBe('Codex 公司 High')
    expect(resolve({ aiVaultTitle: prompt })).toBe('Codex 公司 High')
    // Without a quick-command name, a stand-in still names the tab as before.
    expect(resolve({ aiVaultTitle: prompt, quickCommandLabel: null })).toBe('fix the login page')
  })
})
