import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findAppAgentBrowserDriver, stageAppAgentBrowserDriver } from './serve-agent-browser-driver'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe("finding the app's agent-browser driver (#33846)", () => {
  it.each([
    ['linux', 'x64', 'agent-browser-linux-x64'],
    ['darwin', 'arm64', 'agent-browser-darwin-arm64'],
    ['win32', 'x64', 'agent-browser-win32-x64.exe']
  ] as const)('finds the copy a packaged %s app ships in resources', (platform, arch, name) => {
    const resources = mkdtempSync(join(tmpdir(), 'orca-serve-agent-browser-'))
    roots.push(resources)
    mkdirSync(join(resources, 'app.asar.unpacked'))
    writeFileSync(join(resources, name), '')
    expect(findAppAgentBrowserDriver(join(resources, 'app.asar.unpacked'), platform, arch)).toBe(
      join(resources, name)
    )
    expect(findAppAgentBrowserDriver(join(resources, 'app.asar.unpacked'), platform, 'ia32')).toBe(
      undefined
    )
  })

  // A running daemon locks its image on Windows; lending the installed copy would block app updates.
  it('hands Windows orcad a profile copy outside the app install', async () => {
    const resources = mkdtempSync(join(tmpdir(), 'orca-serve-agent-browser-'))
    const profile = mkdtempSync(join(tmpdir(), 'orca-serve-agent-browser-profile-'))
    roots.push(resources, profile)
    mkdirSync(join(resources, 'app.asar.unpacked'))
    writeFileSync(join(resources, 'agent-browser-win32-x64.exe'), 'driver')
    mkdirSync(join(profile, 'orcad-agent-browser', 'previous-release'), { recursive: true })
    // Another live launch still uses its release's copy.
    mkdirSync(join(profile, 'orcad-agent-browser', 'live-release'))
    mkdirSync(join(profile, 'orcad-agent-browser', '.users', 'live-release'), { recursive: true })
    writeFileSync(
      join(profile, 'orcad-agent-browser', '.users', 'live-release', String(process.pid)),
      ''
    )

    const staged = await stageAppAgentBrowserDriver(
      join(resources, 'app.asar.unpacked'),
      profile,
      'win32',
      'x64'
    )

    expect(staged?.startsWith(join(profile, 'orcad-agent-browser'))).toBe(true)
    expect(staged?.endsWith('agent-browser-win32-x64.exe')).toBe(true)
    expect(readdirSync(join(profile, 'orcad-agent-browser'))).toEqual(
      expect.arrayContaining(['live-release'])
    )
    expect(readdirSync(join(profile, 'orcad-agent-browser'))).not.toContain('previous-release')
  })
})
