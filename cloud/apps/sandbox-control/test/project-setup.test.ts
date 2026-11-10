import { describe, expect, it } from 'vitest'
import type { RunCommandParams, SandboxProviderApi } from '../src/sandbox-provider'
import { PROJECT_SETUP_SCRIPTS_FOR_TESTS, startProjectSetup } from '../src/project-setup'

function provider(files: Record<string, string>, stdout = '{"state":"started"}\n') {
  const calls: RunCommandParams[] = []
  const api = {
    readFile: async (_session: string, path: string) => files[path] ?? null,
    runCommand: async (_session: string, params: RunCommandParams) => {
      calls.push(params)
      return { exitCode: 0, stdout, stderr: '' }
    }
  } as unknown as SandboxProviderApi
  return { api, calls }
}

describe('startProjectSetup', () => {
  it('does nothing without an orca.yaml setup script', async () => {
    const none = provider({})
    expect(await startProjectSetup(none.api, 's1')).toBe('not_configured')
    const tabsOnly = provider({ '/vercel/sandbox/project/orca.yaml': 'defaultTabs:\n  - title: x\n' })
    expect(await startProjectSetup(tabsOnly.api, 's1')).toBe('not_configured')
    expect([...none.calls, ...tabsOnly.calls]).toHaveLength(0)
  })

  it('starts the parsed setup script as data, never in the shell line', async () => {
    const p = provider({ '/vercel/sandbox/project/orca.yaml': 'scripts:\n  setup: |\n    echo "$(whoami)" > .marker\n    pnpm install\n' })
    expect(await startProjectSetup(p.api, 's1')).toBe('started')
    const [call] = p.calls
    expect(call!.command).toBe('bash')
    const [flag, launcher, name, script, runner] = call!.args!
    expect([flag, name]).toEqual(['-c', 'orca-project-setup'])
    expect(launcher).toBe(PROJECT_SETUP_SCRIPTS_FOR_TESTS.LAUNCHER)
    expect(runner).toBe(PROJECT_SETUP_SCRIPTS_FOR_TESTS.RUNNER)
    expect(launcher).not.toContain('pnpm install')
    // Same runner text as the desktop's setup terminal: bash with `set -e`.
    expect(script).toBe('#!/usr/bin/env bash\nset -e\necho "$(whoami)" > .marker\npnpm install\n')
  })

  it('reports the launcher state, and failed on output it does not recognize', async () => {
    const yaml = { '/vercel/sandbox/project/orca.yaml': 'scripts:\n  setup: make deps\n' }
    expect(await startProjectSetup(provider(yaml, '{"state":"already"}\n').api, 's1')).toBe('already')
    expect(await startProjectSetup(provider(yaml, '{"state":"skipped_environment_build"}\n').api, 's1')).toBe('skipped_environment_build')
    expect(await startProjectSetup(provider(yaml, 'bash: oops\n').api, 's1')).toBe('failed')
  })

  it('claims the run atomically and skips environment-build checkouts', () => {
    const { LAUNCHER } = PROJECT_SETUP_SCRIPTS_FOR_TESTS
    expect(LAUNCHER).toContain('(set -C; : >"$D/started")')
    expect(LAUNCHER).toContain('orca-env-deps')
  })
})
