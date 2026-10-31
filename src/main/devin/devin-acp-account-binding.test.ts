import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ManagedDataAccountService } from '../managed-data-accounts/service'
import { devinAcpAccountBinding, scrubDevinAcpEnvironment } from './devin-acp-account-binding'

let root: string
let service: ManagedDataAccountService

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-devin-account-binding-'))
  service = new ManagedDataAccountService(join(root, 'managed'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

async function addManagedAccount(): Promise<string> {
  const source = join(root, 'source')
  mkdirSync(join(source, 'devin'), { recursive: true })
  writeFileSync(join(source, 'devin', 'credentials.toml'), 'windsurf_api_key = "test-only"\n')
  await service.add('devin', source, 'Work')
  return service.launchEnvironment('devin').XDG_DATA_HOME
}

function binding(platform: NodeJS.Platform = 'darwin') {
  return devinAcpAccountBinding({
    managedAccounts: () => service,
    platform,
    homePath: '/home/u',
    processEnv: {}
  })
}

const resolveInput = (launchEnv: NodeJS.ProcessEnv) => ({ launchEnv, stateDirectory: '/state' })

describe('Devin chat account binding', () => {
  it('pins the default data folder without exporting it to the child', async () => {
    const home = await binding().resolve(resolveInput({}))
    expect(home).toEqual({ variable: 'XDG_DATA_HOME', path: '/home/u/.local/share' })
    const env = binding().environment(home, { PATH: '/bin' })
    expect(env).toEqual({ PATH: '/bin' })
    expect(scrubDevinAcpEnvironment(env)).toContain('XDG_DATA_HOME')
  })

  it('launches a managed account without an inherited API key that would override its sign-in', async () => {
    const dataHome = await addManagedAccount()
    const home = await binding().resolve(resolveInput({ XDG_DATA_HOME: '/custom' }))
    expect(home).toEqual({ variable: 'XDG_DATA_HOME', path: dataHome })
    const env = binding().environment(home, { WINDSURF_API_KEY: 'other-account' })
    expect(env).toEqual({ XDG_DATA_HOME: dataHome })
    expect(scrubDevinAcpEnvironment(env)).toContain('WINDSURF_API_KEY')
  })

  it('refuses to start a chat whose managed account was removed rather than recreate its folder', async () => {
    const dataHome = await addManagedAccount()
    const home = await binding().resolve(resolveInput({}))
    await service.remove('devin', service.list('devin').accounts[0]!.id)
    expect(() => binding().environment(home, {})).toThrow('was removed')
    expect(home).toEqual({ variable: 'XDG_DATA_HOME', path: dataHome })
  })

  it("keeps the person's own API key for their unmanaged sign-in", async () => {
    const home = await binding().resolve(resolveInput({}))
    const env = binding().environment(home, { WINDSURF_API_KEY: 'mine' })
    expect(env.WINDSURF_API_KEY).toBe('mine')
    expect(scrubDevinAcpEnvironment(env)).not.toContain('WINDSURF_API_KEY')
  })

  it('reads the system data folder under an overlay Orca inherited from a managed terminal', async () => {
    const dataHome = await addManagedAccount()
    const overlay: Record<string, string> = { XDG_DATA_HOME: '/system/data' }
    const selected = service.launchEnvironment('devin')
    service.captureOriginalEnvironment(overlay, selected)
    Object.assign(overlay, selected, {
      ORCA_DATA_ACCOUNT_PROVIDER: 'devin',
      ORCA_DATA_ACCOUNT_DATA_HOME: selected.XDG_DATA_HOME,
      ORCA_DATA_ACCOUNT_STATE_HOME: selected.XDG_STATE_HOME
    })
    await service.select('devin', null)
    const home = await binding().resolve(resolveInput(overlay))
    expect(home).toEqual({ variable: 'XDG_DATA_HOME', path: '/system/data' })
    const env = binding().environment(home, overlay)
    expect(env.XDG_DATA_HOME).toBe('/system/data')
    expect(Object.values(env)).not.toContain(dataHome)
    expect(Object.keys(env).some((key) => key.startsWith('ORCA_DATA_ACCOUNT_'))).toBe(false)
  })

  it('pins APPDATA on Windows, where managed accounts do not move Devin, and refuses another agent’s account', async () => {
    const dataHome = await addManagedAccount()
    const home = await binding('win32').resolve(resolveInput({}))
    expect(home).toMatchObject({ variable: 'APPDATA' })
    expect(home).not.toMatchObject({ path: dataHome })
    expect(() => binding('win32').environment({ variable: 'GROK_HOME', path: '/g' }, {})).toThrow()
  })
})
