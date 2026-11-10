import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolvePiSessionsDir } from './pi-session-root'

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
    expect(
      resolvePiSessionsDir({ env: {}, homeDir: await homeWithSettings({ sessionDir: 'rel' }) })
    ).toBe(join(homedir(), '.pi', 'agent', 'sessions'))
    expect(
      resolvePiSessionsDir({ env: {}, homeDir: await homeWithSettings({ sessionDir: 7 }) })
    ).toBe(join(homedir(), '.pi', 'agent', 'sessions'))
  })
})
