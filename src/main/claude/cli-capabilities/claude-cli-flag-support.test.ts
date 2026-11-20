import { describe, expect, it } from 'vitest'
import { claudeStreamJsonExitError } from '../sdk-transport/claude-stream-json-exit-error'
import { CLAUDE_PLUGIN_DIR_FLAG, createClaudeCliFlagSupport } from './claude-cli-flag-support'

const launch = { command: '/bin/claude', cwd: '/repo', env: {} }
const SIDELOAD_REFUSAL =
  "disabled by your organization's managed settings (disableSideloadFlags). Plugins, custom agents, and MCP servers can only be loaded from sources your administrator has approved."

function flagSupport() {
  return createClaudeCliFlagSupport({
    probe: async () => '2.1.328',
    keyOf: async (command, cwd) => `${command}\n${cwd}`,
    budgetMs: 1_000,
    now: () => performance.now()
  })
}

function exitWith(stderr: string) {
  return claudeStreamJsonExitError(stderr, { code: 1, signal: null, processless: false })
}

describe('claudeCliFlagSupport.observeExit', () => {
  it('stops offering the flag when the managed-settings refusal names several items', async () => {
    const support = flagSupport()
    expect(await support.check(CLAUDE_PLUGIN_DIR_FLAG, launch)).toBe('supported')

    support.observeExit(
      launch,
      exitWith(`--plugin-dir, --agents, plugins (initialize request) are ${SIDELOAD_REFUSAL}`)
    )

    await expect.poll(() => support.check(CLAUDE_PLUGIN_DIR_FLAG, launch)).toBe('unsupported')
  })

  it('keeps a managed-settings refusal to the account whose policy refused it', async () => {
    const support = flagSupport()
    const locked = { ...launch, env: { CLAUDE_CONFIG_DIR: '/accounts/locked' } }
    const open = { ...launch, env: { CLAUDE_CONFIG_DIR: '/accounts/open' } }

    support.observeExit(locked, exitWith(`--plugin-dir is ${SIDELOAD_REFUSAL}`))

    await expect.poll(() => support.check(CLAUDE_PLUGIN_DIR_FLAG, locked)).toBe('unsupported')
    expect(await support.check(CLAUDE_PLUGIN_DIR_FLAG, open)).toBe('supported')
    expect(await support.check(CLAUDE_PLUGIN_DIR_FLAG, launch)).toBe('supported')
  })

  it('applies an unknown-option refusal to every account', async () => {
    const support = flagSupport()
    support.observeExit(
      { ...launch, env: { CLAUDE_CONFIG_DIR: '/accounts/a' } },
      exitWith("error: unknown option '--plugin-dir'")
    )

    await expect
      .poll(() =>
        support.check(CLAUDE_PLUGIN_DIR_FLAG, {
          ...launch,
          env: { CLAUDE_CONFIG_DIR: '/accounts/b' }
        })
      )
      .toBe('unsupported')
  })
})
