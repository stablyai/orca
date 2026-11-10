import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ompProfileSessionsDirs,
  ompProfileSessionsDirsAsync,
  resolveOmpSessionsDir
} from './omp-session-root'
import { ompSessionsRootDirs } from '../../session-scanner-roots'
import { AI_VAULT_AGENT_SOURCES } from '../../session-scanner-agent-sources'
import { resolveSessionFilePath } from '../../../native-chat/session-file-resolver'

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
  it.each(['', ' ', '/', 'C:\\', 'C:/', 'C:', 'C:.'])(
    'refuses explicit degenerate root %j without fallback',
    (sessionsDir) => {
      expect(resolveOmpSessionsDir({ sessionsDir })).toBe('')
      expect(ompSessionsRootDirs({ ompSessionsDir: sessionsDir })).toEqual([])
      expect(AI_VAULT_AGENT_SOURCES.omp?.rootDirs({ ompSessionsDir: sessionsDir }, [])).toEqual([])
    }
  )
  it.each(['../other', 'CON', 'work.', 'two words'])(
    'refuses invalid profile %s',
    (OMP_PROFILE) => {
      expect(resolveOmpSessionsDir({ env: { OMP_PROFILE } })).toBe('')
    }
  )
  it('uses the same live default for discovery, path allowlisting and native chat', async () => {
    const { home, xdg } = fixture()
    const sessions = join(xdg, 'omp', 'sessions')
    mkdirSync(join(sessions, 'repo'), { recursive: true })
    const transcript = join(sessions, 'repo', 'stamp_omp-session.jsonl')
    writeFileSync(transcript, '{}\n')
    for (const key of [
      'OMP_CODING_AGENT_DIR',
      'PI_CODING_AGENT_DIR',
      'OMP_PROFILE',
      'PI_PROFILE'
    ]) {
      vi.stubEnv(key, undefined)
    }
    // Pin discovery to the fixture home so real profile dirs cannot leak in.
    vi.stubEnv('HOME', home)
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

describe('ompProfileSessionsDirs', () => {
  it('lists only existing session dirs of valid profiles', () => {
    const { home } = fixture()
    const valid = join(home, '.omp', 'profiles', 'qwen', 'agent', 'sessions')
    mkdirSync(valid, { recursive: true })
    mkdirSync(join(home, '.omp', 'profiles', 'empty-profile', 'agent'), { recursive: true })
    mkdirSync(join(home, '.omp', 'profiles', 'work.', 'agent', 'sessions'), { recursive: true })
    mkdirSync(join(home, '.omp', 'profiles', 'default', 'agent', 'sessions'), { recursive: true })
    writeFileSync(join(home, '.omp', 'profiles', 'stray-file'), '')
    expect(ompProfileSessionsDirs({ env: {}, homeDir: home, platform: 'linux' })).toEqual([valid])
  })

  it('adds XDG data home variants on POSIX only', () => {
    const { home, xdg } = fixture()
    const local = join(home, '.omp', 'profiles', 'qwen', 'agent', 'sessions')
    const xdgVariant = join(xdg, 'omp', 'profiles', 'qwen', 'sessions')
    mkdirSync(local, { recursive: true })
    mkdirSync(xdgVariant, { recursive: true })
    expect(
      ompProfileSessionsDirs({ env: { XDG_DATA_HOME: xdg }, homeDir: home, platform: 'linux' })
    ).toEqual([local, xdgVariant].sort())
    expect(
      ompProfileSessionsDirs({ env: { XDG_DATA_HOME: xdg }, homeDir: home, platform: 'win32' })
    ).toEqual([local])
  })

  it('discovers profiles that exist only in the XDG data home', () => {
    const { home, xdg } = fixture()
    const xdgOnly = join(xdg, 'omp', 'profiles', 'fast', 'sessions')
    mkdirSync(xdgOnly, { recursive: true })
    expect(
      ompProfileSessionsDirs({ env: { XDG_DATA_HOME: xdg }, homeDir: home, platform: 'linux' })
    ).toEqual([xdgOnly])
    expect(
      ompProfileSessionsDirs({ env: { XDG_DATA_HOME: xdg }, homeDir: home, platform: 'win32' })
    ).toEqual([])
  })

  it('stays empty under the legacy OMP_CODING_AGENT_DIR override', () => {
    const { home } = fixture()
    mkdirSync(join(home, '.omp', 'profiles', 'qwen', 'agent', 'sessions'), { recursive: true })
    expect(
      ompProfileSessionsDirs({
        env: { OMP_CODING_AGENT_DIR: '/opt/omp' },
        homeDir: home,
        platform: 'linux'
      })
    ).toEqual([])
  })

  it('honors PI_CONFIG_DIR', () => {
    const { home } = fixture()
    const dir = join(home, 'cfg', 'profiles', 'qwen', 'agent', 'sessions')
    mkdirSync(dir, { recursive: true })
    expect(
      ompProfileSessionsDirs({
        env: { PI_CONFIG_DIR: 'cfg' },
        homeDir: home,
        platform: 'linux'
      })
    ).toEqual([dir])
  })
})

describe('ompProfileSessionsDirsAsync', () => {
  it('matches the sync scan across local, XDG, and invalid profiles', async () => {
    const { home, xdg } = fixture()
    const local = join(home, '.omp', 'profiles', 'qwen', 'agent', 'sessions')
    const xdgVariant = join(xdg, 'omp', 'profiles', 'fast', 'sessions')
    mkdirSync(local, { recursive: true })
    mkdirSync(xdgVariant, { recursive: true })
    mkdirSync(join(home, '.omp', 'profiles', 'work.', 'agent', 'sessions'), { recursive: true })
    writeFileSync(join(home, '.omp', 'profiles', 'stray-file'), '')
    const args = { env: { XDG_DATA_HOME: xdg }, homeDir: home, platform: 'linux' as const }
    await expect(ompProfileSessionsDirsAsync(args)).resolves.toEqual(ompProfileSessionsDirs(args))
  })

  it('stays empty under the legacy OMP_CODING_AGENT_DIR override', async () => {
    const { home } = fixture()
    mkdirSync(join(home, '.omp', 'profiles', 'qwen', 'agent', 'sessions'), { recursive: true })
    await expect(
      ompProfileSessionsDirsAsync({
        env: { OMP_CODING_AGENT_DIR: '/opt/omp' },
        homeDir: home,
        platform: 'linux'
      })
    ).resolves.toEqual([])
  })
})

describe('OMP profile history parity', () => {
  it('discovers profile runs the app process did not launch', async () => {
    const { home } = fixture()
    const profileSessions = join(home, '.omp', 'profiles', 'qwen', 'agent', 'sessions')
    const transcript = join(profileSessions, 'repo', 'stamp_profile-session.jsonl')
    mkdirSync(dirname(transcript), { recursive: true })
    writeFileSync(transcript, '{}\n')
    for (const key of [
      'OMP_CODING_AGENT_DIR',
      'PI_CODING_AGENT_DIR',
      'OMP_PROFILE',
      'PI_PROFILE',
      'XDG_DATA_HOME'
    ]) {
      vi.stubEnv(key, undefined)
    }
    vi.stubEnv('HOME', home)
    if (process.platform === 'win32') {
      return
    }
    expect(ompSessionsRootDirs({})).toContain(profileSessions)
    expect(AI_VAULT_AGENT_SOURCES.omp?.rootDirs({}, [])).toContain(profileSessions)
    await expect(resolveSessionFilePath('omp', 'profile-session')).resolves.toBe(transcript)
  })
})
