import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'smol-toml'
import {
  syncSystemConfigIntoManagedCodexHome,
  prepareSystemConfigForFreshRuntimeMirror
} from './codex-config-mirror'
import { promoteCodexRuntimeSettingsToSystem } from './config-settings-promotion'
import { applyManagedCodexShellProfile } from './codex-managed-shell-profile'
import { extractOrdinaryCodexSettings } from './config-toml-runtime-owned-sections'

let root: string
let profile: string
let system: string
const runtimeHome = () => join(profile, 'codex-runtime-home', 'home')
const read = (home: string) => readFileSync(join(home, 'config.toml'), 'utf8')
const write = (home: string, value: string) => {
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'config.toml'), value)
}
const sync = () => {
  mkdirSync(runtimeHome(), { recursive: true })
  syncSystemConfigIntoManagedCodexHome({ runtimeHomePath: runtimeHome(), systemHomePath: system })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-shell-profile-'))
  profile = join(root, 'profile-one')
  system = join(root, '.codex')
  vi.stubEnv('ORCA_USER_DATA_PATH', profile)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

describe('native managed Codex shell profile', () => {
  it.each(['missing', 'blank'])(
    'retains identity when the system config is %s without erasing runtime settings',
    (source) => {
      if (source === 'blank') {
        write(system, '')
      }
      write(runtimeHome(), 'model = "retained"\n[shell_environment_policy]\ninherit = "none"\n')
      sync()
      expect(parse(read(runtimeHome()))).toEqual({
        model: 'retained',
        shell_environment_policy: { inherit: 'none', set: { ORCA_USER_DATA_PATH: profile } }
      })
    }
  )

  it('seeds only the runtime identity when neither home has config', () => {
    sync()
    expect(parse(read(runtimeHome()))).toEqual({
      shell_environment_policy: { set: { ORCA_USER_DATA_PATH: profile } }
    })
  })
  it.each(['core', 'none', 'all'])(
    'retains only its profile overlay with inherit=%s',
    (inherit) => {
      const original = `model = "chosen-model"\napproval_policy = "never"\n[shell_environment_policy]\ninherit = "${inherit}"\nexclude = ["SECRET_*"]\n[shell_environment_policy.set]\nKEEP = "custom"\n[features]\nhooks = true\n`
      write(system, original)
      sync()
      const mirrored = parse(read(runtimeHome()))
      expect(mirrored).toEqual({
        ...parse(original),
        shell_environment_policy: {
          inherit,
          exclude: ['SECRET_*'],
          set: { KEEP: 'custom', ORCA_USER_DATA_PATH: profile }
        }
      })
      const first = read(runtimeHome())
      sync()
      expect(parse(read(runtimeHome()))).toEqual(mirrored)
      expect(read(runtimeHome())).toBe(first)
      expect(read(system)).toBe(original)
    }
  )

  it.each([
    '[shell_environment_policy]\ninherit = "none"\nset = { KEEP = "yes", ORCA_USER_DATA_PATH = "stale" }',
    'shell_environment_policy = { inherit = "core", set = { ORCA_USER_DATA_PATH = "stale", KEEP = "yes" } }',
    'shell_environment_policy.inherit = "core"\nshell_environment_policy.set.KEEP = "yes"\nshell_environment_policy.set.ORCA_USER_DATA_PATH = "stale"',
    '["shell_environment_policy"."set"]\n"ORCA_USER_DATA_PATH" = "stale"\nKEEP = "yes"',
    '[shell_environment_policy]\ninherit = "core"\nset = { KEEP = "yes" }'
  ])('overrides stale profile without damaging TOML shape: %s', (body) => {
    const original = `model = "chosen-model"\n${body}\n`
    write(system, original)
    sync()
    const parsed = parse(read(runtimeHome()))
    expect(parsed.shell_environment_policy).toMatchObject({
      set: { KEEP: 'yes', ORCA_USER_DATA_PATH: profile }
    })
    sync()
    expect(parse(read(runtimeHome()))).toEqual(parsed)
    expect(read(system)).toBe(original)
  })

  it('preserves multiline user data and replaces a conflicting runtime profile', () => {
    const original =
      'model = "chosen"\ndeveloper_instructions = """\n[shell_environment_policy.set]\nORCA_USER_DATA_PATH = "this is instruction text"\n"""\n[shell_environment_policy]\ninherit = "core"\n'
    write(system, original)
    sync()
    write(runtimeHome(), read(runtimeHome()).replace(JSON.stringify(profile), '"wrong-profile"'))
    sync()
    expect(parse(read(runtimeHome()))).toEqual({
      ...parse(original),
      shell_environment_policy: { inherit: 'core', set: { ORCA_USER_DATA_PATH: profile } }
    })
    expect(read(system)).toBe(original)
  })

  it('does not promote the overlay when user settings change or the system file disappears', () => {
    write(system, 'model = "first"\n[shell_environment_policy]\ninherit = "core"\n')
    sync()
    write(runtimeHome(), read(runtimeHome()).replace('"first"', '"second"'))
    promoteCodexRuntimeSettingsToSystem({ runtimeHomePath: runtimeHome(), systemHomePath: system })
    expect(parse(read(system))).toEqual({
      model: 'second',
      shell_environment_policy: { inherit: 'core' }
    })
    sync()
    rmSync(join(system, 'config.toml'))
    write(runtimeHome(), `approval_policy = "never"\n${read(runtimeHome())}`)
    promoteCodexRuntimeSettingsToSystem({ runtimeHomePath: runtimeHome(), systemHomePath: system })
    expect(parse(read(system))).toEqual({
      model: 'second',
      approval_policy: 'never',
      shell_environment_policy: { inherit: 'core' }
    })
  })

  it('keeps two native profiles isolated including an owned account home', () => {
    write(system, 'model = "chosen-model"\n')
    sync()
    const firstHome = runtimeHome()
    const firstProfile = profile
    profile = join(root, 'profile-two')
    vi.stubEnv('ORCA_USER_DATA_PATH', profile)
    const accountHome = join(profile, 'codex-accounts', 'account-id', 'home')
    mkdirSync(accountHome, { recursive: true })
    writeFileSync(join(accountHome, '.orca-managed-home'), 'account-id')
    syncSystemConfigIntoManagedCodexHome({ runtimeHomePath: accountHome, systemHomePath: system })
    expect(parse(read(accountHome)).shell_environment_policy).toEqual({
      set: { ORCA_USER_DATA_PATH: profile }
    })
    expect(parse(read(firstHome)).shell_environment_policy).toEqual({
      set: { ORCA_USER_DATA_PATH: firstProfile }
    })
  })

  it('does not inject local identity into foreign homes or WSL/SSH mirror content', () => {
    write(system, 'model = "chosen-model"\n')
    const foreignHome = join(root, 'ssh-cached-home')
    mkdirSync(foreignHome, { recursive: true })
    syncSystemConfigIntoManagedCodexHome({
      runtimeHomePath: foreignHome,
      systemHomePath: system,
      systemConfigDir: '/home/remote/.codex'
    })
    expect(parse(read(foreignHome))).toEqual({ model: 'chosen-model' })
    expect(
      parse(prepareSystemConfigForFreshRuntimeMirror(read(system), '/home/wsl/.codex'))
    ).toEqual({ model: 'chosen-model' })
    expect(
      applyManagedCodexShellProfile(read(system), {
        runtimeHomePath: '\\\\wsl.localhost\\Ubuntu\\home\\user\\.orca-codex',
        systemHomePath: '\\\\wsl.localhost\\Ubuntu\\home\\user\\.codex'
      })
    ).toBe(read(system))
    expect(
      applyManagedCodexShellProfile(read(system), {
        runtimeHomePath: system,
        systemHomePath: system
      })
    ).toBe(read(system))
  })

  it.each([
    '[shell_environment_policy.set]\nKEEP = "yes"\nORCA_USER_DATA_PATH = "runtime-owned"\n',
    '[shell_environment_policy]\nset = { ORCA_USER_DATA_PATH = "runtime-owned", KEEP = "yes" }\n',
    'shell_environment_policy = { set = { KEEP = "yes", ORCA_USER_DATA_PATH = "runtime-owned" } }\n'
  ])('strips only the runtime identity when reconstructing system settings', (body) => {
    expect(parse(extractOrdinaryCodexSettings(`model = "model"\n${body}`))).toEqual({
      model: 'model',
      shell_environment_policy: { set: { KEEP: 'yes' } }
    })
  })
})
