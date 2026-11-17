import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPlatformUserDataPath } from '../runtime/profile/metadata'
import { installServeService, readServeServiceStatus, type ServeServiceDeps } from './serve-service'

describe('orca serve service on Windows', () => {
  let home: string
  let bin: string
  let calls: string[][]
  let answer: { code: number | null; out: string }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'zotz-win-serve-service-'))
    bin = join(home, 'bin')
    await mkdir(bin)
    await writeFile(join(bin, 'orca.exe'), '')
    await chmod(join(bin, 'orca.exe'), 0o755)
    calls = []
    answer = { code: 0, out: '' }
    vi.stubEnv('APPDATA', join(home, 'AppData', 'Roaming'))
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(home, { recursive: true, force: true })
  })

  const deps = (userDataPath = getPlatformUserDataPath('win32', home)): ServeServiceDeps => ({
    platform: 'win32',
    env: {
      PATH: bin,
      ORCA_USER_DATA_PATH: userDataPath,
      ELECTRON_RUN_AS_NODE: '1',
      SystemRoot: 'C:\\Windows',
      USERDOMAIN: 'MSI',
      USERNAME: 'zotz'
    },
    homeDir: home,
    uid: 0,
    run: async (program, args) => {
      calls.push([program, ...args])
      return answer
    }
  })

  it('registers a logon task for the stable orca.exe without --supervise', async () => {
    const result = await installServeService(
      { command: null, port: '6768', bind: '100.101.102.103', dryRun: false },
      deps()
    )
    const unitPath = String(result.unitPath)
    const bytes = await readFile(unitPath)
    expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe])
    const xml = bytes.subarray(2).toString('utf16le')
    expect(xml).toContain(`<Command>${join(bin, 'orca.exe')}</Command>`)
    expect(xml).toContain(
      '<Arguments>"serve" "--no-pairing" "--port" "6768" "--bind" "100.101.102.103"</Arguments>'
    )
    expect(xml).toContain('<UserId>MSI\\zotz</UserId>')
    expect(xml).toContain('<LogonType>S4U</LogonType>')
    expect(xml).toContain('<Interval>PT1M</Interval>')
    expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>')
    expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>')
    expect(xml).toContain('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>')
    expect(xml).toContain('<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>')
    expect(xml).not.toContain('--supervise')
    expect(calls).toEqual([
      [
        'C:\\Windows\\System32\\schtasks.exe',
        '/Create',
        '/TN',
        '\\Zotz\\Serve',
        '/XML',
        unitPath,
        '/F'
      ],
      ['C:\\Windows\\System32\\schtasks.exe', '/Run', '/TN', '\\Zotz\\Serve']
    ])
  })

  it('refuses a custom profile, which a task cannot select without environment variables', async () => {
    await expect(
      installServeService({ command: null, dryRun: true }, deps(join(home, 'other-profile')))
    ).rejects.toThrow(/default profile/)
  })

  it('reads the language-independent task state', async () => {
    answer = { code: 0, out: 'Running\r\n' }
    expect(await readServeServiceStatus(deps())).toMatchObject({
      installed: true,
      verdict: 'live',
      detail: 'Running'
    })
    answer = { code: 0, out: 'Missing\r\n' }
    expect(await readServeServiceStatus(deps())).toMatchObject({
      installed: false,
      verdict: 'exited'
    })
    answer = { code: null, out: '' }
    expect((await readServeServiceStatus(deps())).verdict).toBe('unverifiable')
  })
})
