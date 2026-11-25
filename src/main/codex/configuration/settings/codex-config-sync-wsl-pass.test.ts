import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import type * as Os from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'

const { home } = vi.hoisted(() => ({ home: { path: '' } }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof Os>()
  return { ...actual, homedir: () => home.path }
})

import { runCodexConfigSyncWslPass } from './codex-config-sync-wsl-pass'

const MARKER = '# orca: tab edit kept from before the update'

describe.skipIf(process.platform === 'win32')('WSL Codex settings sync inside the distro', () => {
  let systemHome: string
  let runtimeHome: string

  beforeEach(() => {
    home.path = realpathSync(mkdtempSync(join(tmpdir(), 'orca-wsl-sync-')))
    systemHome = join(home.path, '.codex')
    runtimeHome = join(home.path, '.local/share/orca/codex-accounts/acct/home')
    mkdirSync(systemHome, { recursive: true })
    mkdirSync(runtimeHome, { recursive: true })
  })

  afterEach(() => {
    rmSync(home.path, { recursive: true, force: true })
  })

  const writeBaseline = (extra: Record<string, unknown>): void => {
    writeFileSync(
      join(runtimeHome, '.orca-config-settings-baseline.json'),
      JSON.stringify({
        version: 3,
        settings: { model: '"gpt-a"', model_reasoning_effort: '"low"' },
        mcpServers: [],
        ...extra
      })
    )
  }
  const sync = () =>
    runCodexConfigSyncWslPass([
      'sync',
      '--system-home',
      systemHome,
      '--runtime-home',
      runtimeHome,
      '--protocol',
      '1'
    ])
  const systemToml = (): string => readFileSync(join(systemHome, 'config.toml'), 'utf-8')
  const runtimeToml = (): string => readFileSync(join(runtimeHome, 'config.toml'), 'utf-8')
  const baselineFile = (): Record<string, unknown> =>
    JSON.parse(readFileSync(join(runtimeHome, '.orca-config-settings-baseline.json'), 'utf-8'))

  it('promotes a tab edit left pending by the one-way build by rename, and a distro edit wins', () => {
    writeFileSync(
      join(systemHome, 'config.toml'),
      'model = "gpt-a"\nmodel_reasoning_effort = "high"\n'
    )
    writeFileSync(
      join(runtimeHome, 'config.toml'),
      'model = "gpt-b"\nmodel_reasoning_effort = "medium"\n'
    )
    writeBaseline({})
    const inodeBefore = statSync(join(systemHome, 'config.toml')).ino

    const output = sync()

    expect(output.homes[0]).toMatchObject({ runtimeHome, complete: true, error: null })
    expect(systemToml()).toBe('model = "gpt-b"\nmodel_reasoning_effort = "high"\n')
    // Replaced by rename, never truncated and rewritten in place.
    expect(statSync(join(systemHome, 'config.toml')).ino).not.toBe(inodeBefore)
    expect(runtimeToml()).toContain('model = "gpt-b"')
    expect(runtimeToml()).toContain('model_reasoning_effort = "high"')
  })

  it('turns kept values into pending edits: a newer tab edit and a distro edit both still win', () => {
    writeFileSync(
      join(systemHome, 'config.toml'),
      'model = "gpt-a"\nmodel_reasoning_effort = "high"\n'
    )
    writeFileSync(
      join(runtimeHome, 'config.toml'),
      // The tab changed model again after the one-way build kept gpt-b.
      `model = "gpt-c"\nmodel_reasoning_effort = "low" ${MARKER}\n`
    )
    writeBaseline({
      settings: {
        model: `"gpt-b" ${MARKER}`,
        model_reasoning_effort: `"low" ${MARKER}`
      },
      guestCarryForward: {
        settings: {
          model: { raw: '"gpt-b"', system: '"gpt-a"' },
          // The distro changed this key since it was kept: the distro wins.
          model_reasoning_effort: { raw: '"low"', system: '"medium"' }
        },
        registrations: []
      }
    })

    expect(sync().homes[0]).toMatchObject({ complete: true, error: null })
    expect(systemToml()).toBe('model = "gpt-c"\nmodel_reasoning_effort = "high"\n')
    expect(runtimeToml()).not.toContain(MARKER)
    expect(runtimeToml()).toContain('model = "gpt-c"')
    expect(runtimeToml()).toContain('model_reasoning_effort = "high"')
    expect(baselineFile()).not.toHaveProperty('guestCarryForward')
  })

  it('never appends a plugin table beside a plugin the distro defines inline', () => {
    const distro = 'model = "gpt-a"\nplugins = { "docs@market" = { enabled = true } }\n'
    writeFileSync(join(systemHome, 'config.toml'), distro)
    writeFileSync(
      join(runtimeHome, 'config.toml'),
      'model = "gpt-a"\n\n[plugins."docs@market"]\nenabled = false\n'
    )
    writeBaseline({})

    sync()

    // A second definition would leave the user's config unparseable.
    expect(systemToml()).toBe(distro)
  })

  it('still promotes a new plugin table beside dotted plugin keys in the distro', () => {
    writeFileSync(
      join(systemHome, 'config.toml'),
      'model = "gpt-a"\nplugins."docs@market".enabled = true\n'
    )
    writeFileSync(
      join(runtimeHome, 'config.toml'),
      'model = "gpt-a"\nplugins."docs@market".enabled = true\n\n[plugins."new@market"]\nenabled = true\n'
    )
    writeBaseline({})

    sync()

    expect(systemToml()).toContain('[plugins."new@market"]')
    expect(() => parseToml(systemToml())).not.toThrow()
  })

  it('syncs a home whose account store was moved off $HOME through a link', () => {
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'orca-wsl-store-')))
    try {
      rmSync(join(home.path, '.local/share/orca/codex-accounts'), { recursive: true })
      symlinkSync(elsewhere, join(home.path, '.local/share/orca/codex-accounts'))
      const movedHome = join(elsewhere, 'acct/home')
      mkdirSync(movedHome, { recursive: true })
      writeFileSync(join(systemHome, 'config.toml'), 'model = "gpt-a"\n')

      const output = runCodexConfigSyncWslPass([
        'sync',
        '--system-home',
        systemHome,
        '--runtime-home',
        movedHome,
        '--protocol',
        '1'
      ])

      expect(output.homes[0]).toMatchObject({ complete: true, error: null })
      expect(readFileSync(join(movedHome, 'config.toml'), 'utf-8')).toContain('model = "gpt-a"')
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it('refuses paths outside the guest home and drive mounts', () => {
    expect(() =>
      runCodexConfigSyncWslPass([
        'sync',
        '--system-home',
        '/etc/codex',
        '--runtime-home',
        runtimeHome,
        '--protocol',
        '1'
      ])
    ).toThrow(/refuses a path/)
  })
})
