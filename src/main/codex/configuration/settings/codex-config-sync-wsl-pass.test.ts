import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import type * as Os from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

  it('promotes values the one-way build kept once, strips their marks and drops the field', () => {
    writeFileSync(
      join(systemHome, 'config.toml'),
      'model = "gpt-a"\nmodel_reasoning_effort = "high"\n'
    )
    writeFileSync(
      join(runtimeHome, 'config.toml'),
      `model = "gpt-b" ${MARKER}\nmodel_reasoning_effort = "low" ${MARKER}\n`
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
    expect(systemToml()).toBe('model = "gpt-b"\nmodel_reasoning_effort = "high"\n')
    expect(runtimeToml()).not.toContain(MARKER)
    expect(runtimeToml()).toContain('model = "gpt-b"')
    expect(runtimeToml()).toContain('model_reasoning_effort = "high"')
    expect(baselineFile()).not.toHaveProperty('guestCarryForward')
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
