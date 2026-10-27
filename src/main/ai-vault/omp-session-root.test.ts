import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveOmpSessionsDir } from './omp-session-root'
import { ompSessionsRootDirs } from './session-scanner-roots'
import { AI_VAULT_AGENT_SOURCES } from './session-scanner-agent-sources'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'

const roots: string[] = []
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'orca-omp-roots-'))
  roots.push(home)
  return { home, xdg: join(home, 'data'), legacy: join(home, '.omp', 'agent', 'sessions') }
}
afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('OMP session root parity', () => {
  it.each(['linux', 'darwin', 'win32'] as const)(
    'selects migrated data on %s only when supported',
    (platform) => {
      const { home, xdg, legacy } = fixture()
      mkdirSync(legacy, { recursive: true })
      mkdirSync(join(xdg, 'omp'), { recursive: true })
      expect(resolveOmpSessionsDir({ homeDir: home, platform, env: { XDG_DATA_HOME: xdg } })).toBe(
        platform === 'win32' ? legacy : join(xdg, 'omp', 'sessions')
      )
    }
  )
  it('does not infer an XDG default or require the sessions subdirectory to exist', () => {
    const { home, xdg, legacy } = fixture()
    mkdirSync(join(home, '.local', 'share', 'omp', 'sessions'), { recursive: true })
    expect(resolveOmpSessionsDir({ homeDir: home, env: {} })).toBe(legacy)
    expect(resolveOmpSessionsDir({ homeDir: home, env: { XDG_DATA_HOME: xdg } })).toBe(legacy)
    mkdirSync(join(xdg, 'omp'), { recursive: true })
    expect(
      resolveOmpSessionsDir({ homeDir: home, platform: 'linux', env: { XDG_DATA_HOME: xdg } })
    ).toBe(join(xdg, 'omp', 'sessions'))
  })
  it.each([
    { omp: 'work', pi: 'other', expected: 'work' },
    { omp: undefined, pi: 'work', expected: 'work' },
    { omp: '', pi: 'work', expected: '' },
    { omp: 'default', pi: 'work', expected: '' }
  ])('honors canonical profile selection %j', ({ omp, pi, expected }) => {
    const { home, xdg } = fixture()
    const env = {
      OMP_PROFILE: omp,
      PI_PROFILE: pi,
      XDG_DATA_HOME: xdg,
      PI_CONFIG_DIR: '.config/omp'
    }
    mkdirSync(join(xdg, 'omp'), { recursive: true })
    const fallback = join(
      home,
      '.config',
      'omp',
      ...(expected ? ['profiles', expected] : []),
      'agent',
      'sessions'
    )
    expect(resolveOmpSessionsDir({ homeDir: home, platform: 'linux', env })).toBe(
      expected ? fallback : join(xdg, 'omp', 'sessions')
    )
    mkdirSync(join(xdg, 'omp', 'profiles', 'work'), { recursive: true })
    expect(resolveOmpSessionsDir({ homeDir: home, platform: 'linux', env })).toBe(
      join(xdg, 'omp', ...(expected ? ['profiles', expected] : []), 'sessions')
    )
  })
  it('uses custom agent paths only in default mode and discards inherited profile-derived paths', () => {
    const { home, xdg, legacy } = fixture()
    mkdirSync(join(xdg, 'omp'), { recursive: true })
    const env = { XDG_DATA_HOME: xdg, PI_CODING_AGENT_DIR: join(home, 'custom') }
    expect(resolveOmpSessionsDir({ homeDir: home, env })).toBe(join(home, 'custom', 'sessions'))
    expect(resolveOmpSessionsDir({ homeDir: home, env: { ...env, OMP_PROFILE: 'work' } })).toBe(
      join(home, '.omp', 'profiles', 'work', 'agent', 'sessions')
    )
    const inherited = {
      OMP_PROFILE: '',
      PI_PROFILE: 'work',
      PI_CODING_AGENT_DIR: join(home, '.omp', 'profiles', 'work', 'agent')
    }
    expect(resolveOmpSessionsDir({ homeDir: home, env: inherited })).toBe(legacy)
  })
  it.each(['.omp', '.omp/agent', '.omp/agent/sessions', 'custom-sessions'])(
    'preserves the legacy override %s over XDG and profiles',
    (suffix) => {
      const { home, xdg, legacy } = fixture()
      mkdirSync(join(xdg, 'omp'), { recursive: true })
      const root = join(home, suffix)
      expect(
        resolveOmpSessionsDir({
          homeDir: home,
          env: { OMP_CODING_AGENT_DIR: root, XDG_DATA_HOME: xdg, OMP_PROFILE: 'work' }
        })
      ).toBe(suffix === 'custom-sessions' ? root : legacy)
    }
  )
  it.each(['', ' ', '/', 'C:\\', 'C:/', 'C:', 'C:.'])(
    'refuses explicit degenerate root %j without fallback',
    (sessionsDir) => {
      expect(resolveOmpSessionsDir({ sessionsDir })).toBe('')
      expect(ompSessionsRootDirs({ ompSessionsDir: sessionsDir })).toEqual([])
      expect(AI_VAULT_AGENT_SOURCES.omp?.rootDirs({ ompSessionsDir: sessionsDir }, [])).toEqual([])
    }
  )
  it.each(['/', '/..', 'C:\\', 'C:/', 'C:', 'C:.'])(
    'does not replace a refused legacy root %s with XDG',
    (override) => {
      const { home, xdg } = fixture()
      mkdirSync(join(xdg, 'omp'), { recursive: true })
      expect(
        resolveOmpSessionsDir({
          homeDir: home,
          env: { OMP_CODING_AGENT_DIR: override, XDG_DATA_HOME: xdg }
        })
      ).toBe('')
    }
  )
  it.each(['../other', 'CON', 'work.', 'two words'])(
    'refuses invalid profile %s',
    (OMP_PROFILE) => {
      expect(resolveOmpSessionsDir({ env: { OMP_PROFILE } })).toBe('')
    }
  )
  it('uses the same live default for discovery, path allowlisting and native chat', async () => {
    const { xdg } = fixture()
    const sessions = join(xdg, 'omp', 'sessions')
    mkdirSync(join(sessions, 'repo'), { recursive: true })
    const transcript = join(sessions, 'repo', 'stamp_omp-session.jsonl')
    writeFileSync(transcript, '{}\n')
    for (const key of [
      'OMP_CODING_AGENT_DIR',
      'PI_CODING_AGENT_DIR',
      'OMP_PROFILE',
      'PI_PROFILE',
      'PI_CONFIG_DIR'
    ]) {
      vi.stubEnv(key, undefined)
    }
    vi.stubEnv('XDG_DATA_HOME', xdg)
    if (process.platform === 'win32') {
      return
    }
    expect(ompSessionsRootDirs({})).toEqual([sessions])
    expect(AI_VAULT_AGENT_SOURCES.omp?.rootDirs({}, [])).toEqual([sessions])
    await expect(resolveSessionFilePath('omp', 'omp-session')).resolves.toBe(transcript)
    await expect(
      resolveSessionFilePath('omp', 'omp-session', { ompSessionsDir: '' })
    ).resolves.toBeNull()
    await expect(
      resolveSessionFilePath('omp', 'omp-session', { wslDistro: 'isolated' })
    ).resolves.toBeNull()
  })
})
