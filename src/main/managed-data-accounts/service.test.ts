import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type * as fileSystem from 'node:fs'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManagedDataAccountService } from './service'

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof fileSystem>())
}))

let root: string
let source: string
let service: ManagedDataAccountService

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-data-accounts-test-'))
  source = join(root, 'source')
  mkdirSync(join(source, 'devin'), { recursive: true })
  writeFileSync(join(source, 'devin', 'credentials.toml'), 'windsurf_api_key = "test-only-key"\n')
  service = new ManagedDataAccountService(join(root, 'managed'), undefined, { platform: 'linux' })
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

describe('managed data accounts', () => {
  it('serializes overlapping enrollment so neither account is lost', async () => {
    await Promise.all([service.add('devin', source, 'One'), service.add('devin', source, 'Two')])
    expect(service.list('devin').accounts.map((account) => account.label)).toEqual(['One', 'Two'])
  })

  it('switches Devin Windows credentials and restores the system login', async () => {
    const appData = join(root, 'appdata')
    const liveCredential = join(appData, 'devin', 'credentials.toml')
    mkdirSync(join(appData, 'devin'), { recursive: true })
    writeFileSync(liveCredential, 'windsurf_api_key = "system-default"\n')
    const windowsService = new ManagedDataAccountService(join(root, 'windows-managed'), undefined, {
      platform: 'win32',
      devinAppDataRoot: appData
    })

    const first = await windowsService.add('devin', source, 'One')
    expect(readFileSync(liveCredential, 'utf8')).toContain('test-only-key')
    writeFileSync(liveCredential, 'windsurf_api_key = "stale-host-value"\n')
    await windowsService.syncLaunchCredentials('devin', windowsService.launchEnvironment('devin'))
    expect(readFileSync(liveCredential, 'utf8')).toContain('test-only-key')

    const secondSource = join(root, 'second-source')
    mkdirSync(join(secondSource, 'devin'), { recursive: true })
    writeFileSync(
      join(secondSource, 'devin', 'credentials.toml'),
      'windsurf_api_key = "second-account"\n'
    )
    const second = await windowsService.add('devin', secondSource, 'Two')
    expect(readFileSync(liveCredential, 'utf8')).toContain('second-account')

    const firstId = first.accounts.at(-1)!.id
    const secondId = second.accounts.at(-1)!.id
    await windowsService.select('devin', firstId)
    expect(readFileSync(liveCredential, 'utf8')).toContain('test-only-key')

    await windowsService.select('devin', null)
    expect(readFileSync(liveCredential, 'utf8')).toBe('windsurf_api_key = "system-default"\n')

    await windowsService.select('devin', secondId)
    await windowsService.remove('devin', secondId)
    expect(readFileSync(liveCredential, 'utf8')).toBe('windsurf_api_key = "system-default"\n')
  })

  it('removes a mirrored Devin credential when no system login existed', async () => {
    const appData = join(root, 'empty-appdata')
    const liveCredential = join(appData, 'devin', 'credentials.toml')
    const windowsService = new ManagedDataAccountService(join(root, 'empty-managed'), undefined, {
      platform: 'win32',
      devinAppDataRoot: appData
    })

    const state = await windowsService.add('devin', source, 'One')
    expect(readFileSync(liveCredential, 'utf8')).toContain('test-only-key')

    await windowsService.remove('devin', state.accounts.at(-1)!.id)
    expect(existsSync(liveCredential)).toBe(false)
  })
})
