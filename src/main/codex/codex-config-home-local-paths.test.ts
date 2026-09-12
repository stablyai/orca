import { describe, expect, it } from 'vitest'
import { rewriteHomeLocalConfigValues } from './codex-config-path-reference-rewrite'

const SOURCE_HOME = '/home/user/.codex'
const RUNTIME_HOME = '/home/user/.config/orca/codex-runtime-home/home'

/** Pure cases: the target is assumed present so they exercise path semantics.
 *  The existence condition itself is covered by its own describe below. */
const rewrite = (config: string): string =>
  rewriteHomeLocalConfigValues(config, SOURCE_HOME, RUNTIME_HOME, () => true)

// STA-6706: a bundled marketplace only loads when its source sits inside the
// ACTIVE CODEX_HOME. Copying the value verbatim points the runtime home at the
// standalone home, and Codex silently drops the plugin.
describe('home-local config paths (STA-6706)', () => {
  it('re-roots a bundled marketplace source onto the runtime home', () => {
    const config = [
      '[marketplaces.openai-bundled]',
      `source = "${SOURCE_HOME}/.tmp/bundled-marketplaces/openai-bundled"`
    ].join('\n')

    expect(rewrite(config)).toContain(
      `source = '${RUNTIME_HOME}/.tmp/bundled-marketplaces/openai-bundled'`
    )
  })

  it('re-roots a tilde-written source the same way', () => {
    const config = ['[marketplaces.openai-bundled]', "source = '~/.codex/.tmp/bundled'"].join('\n')

    // Only meaningful when the tilde really resolves to the source home.
    const rewritten = rewriteHomeLocalConfigValues(
      config,
      `${process.env.HOME}/.codex`,
      RUNTIME_HOME,
      () => true
    )

    expect(rewritten).toContain(`source = '${RUNTIME_HOME}/.tmp/bundled'`)
  })

  it('re-roots an MCP server CODEX_HOME so the child sees the active home', () => {
    const config = ['[mcp_servers.node_repl.env]', `CODEX_HOME = "${SOURCE_HOME}"`].join('\n')

    expect(rewrite(config)).toContain(`CODEX_HOME = '${RUNTIME_HOME}'`)
  })

  it('leaves a path outside the source home untouched', () => {
    const config = ['[marketplaces.local]', "source = '/opt/shared/marketplace'"].join('\n')

    // Not Orca's to move: the user pointed outside the home deliberately.
    expect(rewrite(config)).toBe(config)
  })

  it('leaves ordinary settings untouched', () => {
    const config = ['model = "gpt-5"', `log_dir = "${SOURCE_HOME}/logs"`].join('\n')

    // log_dir is anchored to the SOURCE home by the other rewrite; re-rooting it
    // here would move the user's logs out from under them.
    expect(rewrite(config)).toBe(config)
  })

  it('is a no-op when both homes are the same', () => {
    const config = ['[marketplaces.openai-bundled]', `source = "${SOURCE_HOME}/.tmp/b"`].join('\n')

    expect(rewriteHomeLocalConfigValues(config, SOURCE_HOME, SOURCE_HOME, () => true)).toBe(config)
  })
})

// Windows homes are backslash paths. The first implementation used posix
// helpers unconditionally, so `relative()` returned `../C:\Users\...`, the
// escape guard rejected it, and every value was left verbatim — a silent no-op
// on the platform, with six passing posix cases hiding it.
describe('home-local config paths on Windows', () => {
  const WIN_SOURCE = 'C:\\Users\\dev\\.codex'
  const WIN_RUNTIME = 'C:\\Users\\dev\\AppData\\Roaming\\orca\\codex-runtime-home\\home'

  it('re-roots a bundled marketplace source across Windows homes', () => {
    const config = [
      '[marketplaces.openai-bundled]',
      `source = '${WIN_SOURCE}\\.tmp\\bundled-marketplaces\\openai-bundled'`
    ].join('\n')

    const rewritten = rewriteHomeLocalConfigValues(config, WIN_SOURCE, WIN_RUNTIME, () => true)

    expect(rewritten).toContain('AppData\\Roaming\\orca\\codex-runtime-home\\home')
    expect(rewritten).not.toContain(`${WIN_SOURCE}\\.tmp`)
  })

  it('leaves a Windows path outside the source home untouched', () => {
    const config = ['[marketplaces.local]', "source = 'D:\\shared\\marketplace'"].join('\n')

    expect(rewriteHomeLocalConfigValues(config, WIN_SOURCE, WIN_RUNTIME, () => true)).toBe(config)
  })
})

describe('home-local key matching', () => {
  it('does not re-root a nested table that merely ends in source', () => {
    // `marketplaces.x.auth.source` is not a marketplace root; re-rooting it
    // would point at a directory the mirror never copies.
    const config = ['[marketplaces.x.auth]', "source = '/home/user/.codex/creds'"].join('\n')

    expect(
      rewriteHomeLocalConfigValues(config, '/home/user/.codex', RUNTIME_HOME, () => true)
    ).toBe(config)
  })
})

// The safety argument for the whole rewrite. Codex materialises the bundled
// marketplace directory itself, per home, so a home that never received one has
// nothing to point at. Rewriting there would replace a path that resolves with
// one that does not — strictly worse than doing nothing.
describe('home-local rewrite is conditional on the target existing', () => {
  const config = [
    '[marketplaces.openai-bundled]',
    `source = "${SOURCE_HOME}/.tmp/bundled-marketplaces/openai-bundled"`
  ].join('\n')

  it('leaves the value byte-identical when the runtime home has no such directory', () => {
    const probed: string[] = []

    const rewritten = rewriteHomeLocalConfigValues(config, SOURCE_HOME, RUNTIME_HOME, (path) => {
      probed.push(path)
      return false
    })

    // Byte-identical, not merely "still a valid path": this is the guarantee
    // that the fix cannot make any home worse than it is today.
    expect(rewritten).toBe(config)
    expect(probed).toEqual([`${RUNTIME_HOME}/.tmp/bundled-marketplaces/openai-bundled`])
  })

  it('rewrites once the runtime home really has the directory', () => {
    const rewritten = rewriteHomeLocalConfigValues(
      config,
      SOURCE_HOME,
      RUNTIME_HOME,
      (path) => path === `${RUNTIME_HOME}/.tmp/bundled-marketplaces/openai-bundled`
    )

    expect(rewritten).toContain(`${RUNTIME_HOME}/.tmp/bundled-marketplaces/openai-bundled`)
  })
})

// The WSL scope decision, held by the guard alone. The existence probe is
// forced true here on purpose: without that, a POSIX test host would refuse the
// Windows runtime path for an unrelated reason and this would pass whether or
// not the guard exists — which is exactly how an earlier version of this
// assertion went green after the probe was introduced.
describe('WSL homes are refused by the scope guard, not by chance', () => {
  const WSL_SOURCE = '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.codex'
  const WIN_RUNTIME = 'C:\\Users\\alice\\AppData\\orca\\home'
  const config = [
    '[marketplaces.openai-bundled]',
    `source = '${WSL_SOURCE}\\.tmp\\bundled-marketplaces\\openai-bundled'`
  ].join('\n')

  it('leaves a WSL source home untouched even when the target exists', () => {
    expect(rewriteHomeLocalConfigValues(config, WSL_SOURCE, WIN_RUNTIME, () => true)).toBe(config)
  })

  it('leaves a WSL runtime home untouched even when the target exists', () => {
    const winSource = 'C:\\Users\\alice\\.codex'
    const winConfig = [
      '[marketplaces.openai-bundled]',
      `source = '${winSource}\\.tmp\\bundled-marketplaces\\openai-bundled'`
    ].join('\n')

    expect(
      rewriteHomeLocalConfigValues(
        winConfig,
        winSource,
        '\\\\wsl.localhost\\Ubuntu\\home\\alice\\rt',
        () => true
      )
    ).toBe(winConfig)
  })
})
