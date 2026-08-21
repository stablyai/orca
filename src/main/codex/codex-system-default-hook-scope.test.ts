import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  configTomlHasUserLayerHookDefinitions,
  getDefaultCodexSystemDefaultHookScope,
  planSystemDefaultHookInstall,
  resolveCodexSystemDefaultHookScope
} from './codex-system-default-hook-scope'

const SCOPE_ENV = 'ORCA_CODEX_SYSTEM_DEFAULT_HOOK_SCOPE'
let previousScope: string | undefined

beforeEach(() => {
  previousScope = process.env[SCOPE_ENV]
  delete process.env[SCOPE_ENV]
})

afterEach(() => {
  if (previousScope === undefined) {
    delete process.env[SCOPE_ENV]
  } else {
    process.env[SCOPE_ENV] = previousScope
  }
})

describe('resolveCodexSystemDefaultHookScope', () => {
  it('defaults to the safer orca-sessions scope', () => {
    expect(getDefaultCodexSystemDefaultHookScope()).toBe('orca-sessions')
    expect(resolveCodexSystemDefaultHookScope({})).toBe('orca-sessions')
  })

  it('accepts all-sessions env aliases', () => {
    for (const raw of ['all-sessions', 'all', 'system-default', 'real-home', ' ALL ']) {
      expect(resolveCodexSystemDefaultHookScope({ [SCOPE_ENV]: raw })).toBe('all-sessions')
    }
  })

  it('accepts orca-sessions env aliases', () => {
    for (const raw of ['orca-sessions', 'orca', 'orca-only', 'managed']) {
      expect(resolveCodexSystemDefaultHookScope({ [SCOPE_ENV]: raw })).toBe('orca-sessions')
    }
  })

  it('ignores unrecognized values and stays on the safer default', () => {
    expect(resolveCodexSystemDefaultHookScope({ [SCOPE_ENV]: 'maybe' })).toBe('orca-sessions')
  })
})

describe('planSystemDefaultHookInstall', () => {
  it('sweeps the real home when status hooks are disabled', () => {
    expect(
      planSystemDefaultHookInstall({
        scope: 'all-sessions',
        hooksEnabled: false,
        configTomlHasUserHookDefinitions: false
      })
    ).toEqual({ action: 'sweep-real-home' })
  })

  it('prefers managed CODEX_HOME for the orca-sessions scope', () => {
    expect(
      planSystemDefaultHookInstall({
        scope: 'orca-sessions',
        hooksEnabled: true,
        configTomlHasUserHookDefinitions: false
      })
    ).toEqual({ action: 'prefer-managed', reason: 'orca-sessions-scope' })
  })

  it('installs into the real home only for all-sessions without dual representation', () => {
    expect(
      planSystemDefaultHookInstall({
        scope: 'all-sessions',
        hooksEnabled: true,
        configTomlHasUserHookDefinitions: false
      })
    ).toEqual({ action: 'install-real-home' })
  })

  it('refuses real-home install when config.toml already defines user hooks', () => {
    expect(
      planSystemDefaultHookInstall({
        scope: 'all-sessions',
        hooksEnabled: true,
        configTomlHasUserHookDefinitions: true
      })
    ).toEqual({ action: 'prefer-managed', reason: 'dual-hook-representation' })
  })
})

describe('configTomlHasUserLayerHookDefinitions', () => {
  it('detects array-of-tables hook definitions', () => {
    expect(
      configTomlHasUserLayerHookDefinitions(
        [
          'model = "gpt"',
          '',
          '[[hooks.Stop]]',
          '[[hooks.Stop.hooks]]',
          'type = "command"',
          ''
        ].join('\n')
      )
    ).toBe(true)
  })

  it('ignores hooks.state trust tables Orca writes next to hooks.json', () => {
    expect(
      configTomlHasUserLayerHookDefinitions(
        [
          '[features]',
          'hooks = true',
          '',
          '[hooks.state."/home/u/.codex/hooks.json:stop:0:0"]',
          'trusted_hash = "sha256:abc"',
          ''
        ].join('\n')
      )
    ).toBe(false)
  })

  it('ignores hook-looking headers inside multiline strings', () => {
    expect(
      configTomlHasUserLayerHookDefinitions(
        ['notes = """', '[[hooks.Stop]]', 'is documentation only', '"""', ''].join('\n')
      )
    ).toBe(false)
  })

  it('treats a bare [hooks] table as a user-layer definition container', () => {
    expect(configTomlHasUserLayerHookDefinitions('[hooks]\n')).toBe(true)
  })
})
