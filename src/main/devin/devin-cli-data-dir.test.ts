import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDevinCredentialsPath } from '../rate-limits/devin-credentials'
import { resolveDevinCliDataDir, resolveDevinTranscriptsDir } from './devin-cli-data-dir'

/**
 * The CLI data dir must track the documented layout per platform
 * (docs.devin.ai/cli/enterprise/devin-auth): credentials.toml sits one level
 * above the cli/ data dir, so a wrong default silently reads nothing and Orca
 * reports "not signed in" for a user who is signed in.
 */

const realPlatform = process.platform
const WIN_APPDATA = 'C:\\Users\\test\\AppData\\Roaming'

function stubPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

describe('resolveDevinCliDataDir', () => {
  beforeEach(() => {
    vi.stubEnv('DEVIN_HOME', undefined)
    vi.stubEnv('XDG_DATA_HOME', undefined)
    vi.stubEnv('APPDATA', undefined)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    stubPlatform(realPlatform)
  })

  it('defaults to ~/.local/share/devin/cli on posix', () => {
    stubPlatform('linux')
    expect(resolveDevinCliDataDir()).toBe(join(homedir(), '.local', 'share', 'devin', 'cli'))
  })

  it('honours XDG_DATA_HOME on posix', () => {
    stubPlatform('darwin')
    vi.stubEnv('XDG_DATA_HOME', '/custom/share')
    expect(resolveDevinCliDataDir()).toBe(join('/custom/share', 'devin', 'cli'))
  })

  it('uses APPDATA on win32', () => {
    stubPlatform('win32')
    vi.stubEnv('APPDATA', WIN_APPDATA)
    vi.stubEnv('XDG_DATA_HOME', '/custom/share')
    expect(resolveDevinCliDataDir()).toBe(join(WIN_APPDATA, 'devin', 'cli'))
  })

  it('falls back to the roaming profile on win32 without APPDATA', () => {
    stubPlatform('win32')
    expect(resolveDevinCliDataDir()).toBe(join(homedir(), 'AppData', 'Roaming', 'devin', 'cli'))
  })

  it('lets an absolute DEVIN_HOME win over the posix default', () => {
    stubPlatform('linux')
    vi.stubEnv('XDG_DATA_HOME', '/custom/share')
    vi.stubEnv('DEVIN_HOME', '/opt/devin-cli')
    expect(resolveDevinCliDataDir()).toBe('/opt/devin-cli')
  })

  it('lets an absolute DEVIN_HOME win over the win32 default', () => {
    stubPlatform('win32')
    vi.stubEnv('APPDATA', WIN_APPDATA)
    vi.stubEnv('DEVIN_HOME', 'D:\\devin-cli')
    expect(resolveDevinCliDataDir()).toBe('D:\\devin-cli')
  })

  it('rejects a relative DEVIN_HOME', () => {
    stubPlatform('linux')
    vi.stubEnv('DEVIN_HOME', 'rel/devin')
    expect(resolveDevinCliDataDir()).toBe(join(homedir(), '.local', 'share', 'devin', 'cli'))
  })

  it('puts transcripts under the resolved data dir', () => {
    vi.stubEnv('DEVIN_HOME', '/opt/devin-cli')
    expect(resolveDevinTranscriptsDir()).toBe(join('/opt/devin-cli', 'transcripts'))
  })

  it('places credentials.toml beside the cli dir on posix', () => {
    stubPlatform('linux')
    vi.stubEnv('XDG_DATA_HOME', '/custom/share')
    expect(getDevinCredentialsPath()).toBe(join('/custom/share', 'devin', 'credentials.toml'))
  })

  it('places credentials.toml beside the cli dir on win32', () => {
    stubPlatform('win32')
    vi.stubEnv('APPDATA', WIN_APPDATA)
    expect(getDevinCredentialsPath()).toBe(join(WIN_APPDATA, 'devin', 'credentials.toml'))
  })
})
