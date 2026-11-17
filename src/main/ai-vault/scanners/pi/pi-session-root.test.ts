import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { piSessionsRootDirs, resolvePiSessionsDir } from './pi-session-root'

let tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

async function homeWithSettings(settings: unknown): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'orca-pi-session-root-'))
  tempDirs.push(home)
  const agentDir = join(home, '.pi', 'agent')
  await mkdir(agentDir, { recursive: true })
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify(settings))
  return home
}

describe('resolvePiSessionsDir', () => {
  it('falls back to the default agent sessions dir', () => {
    expect(resolvePiSessionsDir({ env: {} })).toBe(join(homedir(), '.pi', 'agent', 'sessions'))
  })

  it('prefers the environment override over the settings file and the agent home', async () => {
    const home = await homeWithSettings({ sessionDir: '/srv/from-settings' })
    expect(
      resolvePiSessionsDir({
        env: {
          PI_CODING_AGENT_DIR: join(home, '.pi', 'agent'),
          PI_CODING_AGENT_SESSION_DIR: '/srv/from-env'
        },
        homeDir: home
      })
    ).toBe('/srv/from-env')
  })

  it('reads the user-level settings.json sessionDir when the environment is silent', async () => {
    const home = await homeWithSettings({ sessionDir: '/srv/from-settings' })
    expect(
      resolvePiSessionsDir({
        env: { PI_CODING_AGENT_DIR: join(home, '.pi', 'agent') },
        homeDir: home
      })
    ).toBe('/srv/from-settings')
  })

  it('keeps normalizing an agent home that has no settings file', () => {
    const home = join(homedir(), 'no-settings-here')
    expect(resolvePiSessionsDir({ env: { PI_CODING_AGENT_DIR: '/opt/.pi' }, homeDir: home })).toBe(
      join('/opt/.pi', 'agent', 'sessions')
    )
    expect(
      resolvePiSessionsDir({ env: { PI_CODING_AGENT_DIR: '/opt/pi-agent' }, homeDir: home })
    ).toBe('/opt/pi-agent')
  })

  it('expands a tilde and skips non-absolute values from the environment', () => {
    expect(resolvePiSessionsDir({ env: { PI_CODING_AGENT_SESSION_DIR: '~/t' } })).toBe(
      join(homedir(), 't')
    )
    for (const value of ['/', '.', '..', 'rel/path', '   ', 'C:foo']) {
      expect(resolvePiSessionsDir({ env: { PI_CODING_AGENT_SESSION_DIR: value } })).toBe(
        join(homedir(), '.pi', 'agent', 'sessions')
      )
    }
  })

  it('skips a relative or malformed settings value instead of resolving it against a cwd', async () => {
    const relative = await homeWithSettings({ sessionDir: 'rel' })
    expect(resolvePiSessionsDir({ env: {}, homeDir: relative })).toBe(
      join(relative, '.pi', 'agent', 'sessions')
    )
    const malformed = await homeWithSettings({ sessionDir: 7 })
    expect(resolvePiSessionsDir({ env: {}, homeDir: malformed })).toBe(
      join(malformed, '.pi', 'agent', 'sessions')
    )
  })

  it('keeps the configured agent home indexed after an override so older history survives', async () => {
    const home = await homeWithSettings({ sessionDir: '/srv/from-settings' })
    expect(piSessionsRootDirs({ env: {}, homeDir: home })).toEqual([
      '/srv/from-settings',
      join(home, '.pi', 'agent', 'sessions')
    ])
    expect(
      piSessionsRootDirs({
        env: { PI_CODING_AGENT_DIR: '/opt/.pi/agent' },
        homeDir: home
      })
    ).toEqual(['/opt/.pi/agent/sessions'])
    expect(
      piSessionsRootDirs({
        env: {
          PI_CODING_AGENT_DIR: '/opt/.pi/agent',
          PI_CODING_AGENT_SESSION_DIR: '/mnt/transcripts'
        },
        homeDir: home
      })
    ).toEqual(['/mnt/transcripts', '/opt/.pi/agent/sessions'])
  })

  it('ignores a relative PI_CODING_AGENT_DIR instead of resolving it against a cwd', () => {
    expect(
      resolvePiSessionsDir({ env: { PI_CODING_AGENT_DIR: 'rel/dir' }, homeDir: '/srv/home' })
    ).toBe(join('/srv/home', '.pi', 'agent', 'sessions'))
    expect(
      resolvePiSessionsDir({ env: { PI_CODING_AGENT_DIR: '~/agent' }, homeDir: '/srv/home' })
    ).toBe(join('/srv/home', 'agent', 'sessions'))
  })

  it('replaces the default home when a scan option names the root explicitly', () => {
    expect(piSessionsRootDirs({ sessionsDir: '/mnt/explicit' })).toEqual(['/mnt/explicit'])
  })
})
