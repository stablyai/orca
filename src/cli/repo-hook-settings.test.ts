import { describe, expect, it } from 'vitest'
import { hasRepoHookSettingsChange, mergeRepoHookSettings } from './repo-hook-settings'

describe('mergeRepoHookSettings', () => {
  it('keeps the fields the caller did not touch', () => {
    const merged = mergeRepoHookSettings(
      {
        mode: 'override',
        setupRunPolicy: 'skip-by-default',
        setupAgentStartupPolicy: 'wait-for-setup',
        commandSourcePolicy: 'run-both',
        scripts: { setup: 'pnpm install', archive: 'echo bye' }
      },
      { setupScript: 'pnpm install --frozen-lockfile' }
    )

    expect(merged).toEqual({
      mode: 'override',
      setupRunPolicy: 'skip-by-default',
      setupAgentStartupPolicy: 'wait-for-setup',
      commandSourcePolicy: 'run-both',
      scripts: { setup: 'pnpm install --frozen-lockfile', archive: 'echo bye' }
    })
  })

  it('fills the defaults when the repo has no hook settings yet', () => {
    const merged = mergeRepoHookSettings(undefined, { archiveScript: 'echo bye' })

    expect(merged).toEqual({
      mode: 'auto',
      setupRunPolicy: 'run-by-default',
      setupAgentStartupPolicy: 'start-immediately',
      scripts: { setup: '', archive: 'echo bye' }
    })
  })

  it('clears a script when the caller passes an empty value', () => {
    const merged = mergeRepoHookSettings(
      { mode: 'auto', scripts: { setup: 'pnpm install', archive: 'echo bye' } },
      { setupScript: '' }
    )

    expect(merged.scripts).toEqual({ setup: '', archive: 'echo bye' })
  })

  it('replaces only the policies that were passed', () => {
    const merged = mergeRepoHookSettings(
      {
        mode: 'auto',
        setupRunPolicy: 'ask',
        commandSourcePolicy: 'local-only',
        scripts: { setup: '', archive: '' }
      },
      { setupAgentStartupPolicy: 'wait-for-setup' }
    )

    expect(merged.setupRunPolicy).toBe('ask')
    expect(merged.commandSourcePolicy).toBe('local-only')
    expect(merged.setupAgentStartupPolicy).toBe('wait-for-setup')
  })
})

describe('hasRepoHookSettingsChange', () => {
  it('rejects a call that passed no editing flag', () => {
    expect(hasRepoHookSettingsChange({})).toBe(false)
  })

  it('accepts clearing a script', () => {
    expect(hasRepoHookSettingsChange({ setupScript: '' })).toBe(true)
  })
})
