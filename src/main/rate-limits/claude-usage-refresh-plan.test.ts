import { describe, expect, it } from 'vitest'
import { resolveClaudeUsageRefreshPlan } from './claude-usage-refresh-plan'

describe('resolveClaudeUsageRefreshPlan', () => {
  it('uses OAuth then CLI app auto ordering when CLI fallback is available', () => {
    expect(resolveClaudeUsageRefreshPlan({ allowCliFallback: true }).steps).toEqual([
      { source: 'oauth', reason: 'app-auto-preferred-oauth' },
      { source: 'cli', reason: 'app-auto-fallback-cli' }
    ])
  })

  it('keeps web deferred and internal-only for the first parity pass', () => {
    expect(resolveClaudeUsageRefreshPlan({ allowCliFallback: true }).webDeferred).toBe(true)
  })

  it('omits CLI fallback for unresolved WSL Claude config', () => {
    expect(
      resolveClaudeUsageRefreshPlan({
        allowCliFallback: true,
        authPreparation: {
          configDir: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\.claude',
          runtime: 'wsl',
          wslDistro: 'Ubuntu',
          wslLinuxConfigDir: null,
          envPatch: {},
          stripAuthEnv: true,
          provenance: 'wsl:Ubuntu:system'
        }
      }).steps
    ).toEqual([{ source: 'oauth', reason: 'app-auto-preferred-oauth' }])
  })
})
