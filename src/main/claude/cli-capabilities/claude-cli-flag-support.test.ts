import { expect, it } from 'vitest'
import { CLAUDE_PLUGIN_DIR_FLAG, createClaudeCliFlagSupport } from './claude-cli-flag-support'

it('expires managed-settings flag refusals after the TTL while keeping unknown-option refusals', async () => {
  let now = 1_000
  const support = createClaudeCliFlagSupport({
    probe: async () => '2.1.94',
    keyOf: async () => '/usr/bin/claude\n1\n/repo',
    budgetMs: 500,
    now: () => now,
    managedRefusalTtlMs: 60_000
  })
  const launch = { command: 'claude', cwd: '/repo', env: { CLAUDE_CONFIG_DIR: '/acct-a' } }

  expect(await support.check(CLAUDE_PLUGIN_DIR_FLAG, launch)).toBe('supported')

  support.observeExit(
    launch,
    new Error(
      "--plugin-dir is disabled by your organization's managed settings (disableSideloadFlags)"
    )
  )
  await Promise.resolve()

  expect(await support.check(CLAUDE_PLUGIN_DIR_FLAG, launch)).toBe('unsupported')

  now += 60_000
  expect(await support.check(CLAUDE_PLUGIN_DIR_FLAG, launch)).toBe('supported')

  support.observeExit(launch, new Error("unknown option '--plugin-dir'"))
  await Promise.resolve()

  now += 600_000
  expect(await support.check(CLAUDE_PLUGIN_DIR_FLAG, launch)).toBe('unsupported')
})
