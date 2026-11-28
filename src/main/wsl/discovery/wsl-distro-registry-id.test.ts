import { afterEach, expect, it, vi } from 'vitest'
import { readWslDistroRegistrations } from './wsl-distro-registry-id'

const { runProcess } = vi.hoisted(() => ({ runProcess: vi.fn() }))

vi.mock('@orca/process-host', () => ({ runProcess }))
vi.mock('../../windows/windows-native-registry', () => ({
  loadWindowsNativeRegistry: () => ({
    HK: { CU: 1, LM: 2 },
    getRegistryKey: () => ({ OEMCP: { value: '936' } })
  })
}))

const originalPlatform = process.platform

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
})

// `reg query <Lxss> /s` on a cp936 Windows: ASCII except the name, which is GBK (bf aa b7 a2 bb b7 be b3).
const lxssDump = Buffer.concat([
  Buffer.from(
    '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\r\n' +
      '    DefaultDistribution    REG_SZ    {11111111-2222-3333-4444-555555555555}\r\n\r\n'
  ),
  Buffer.from(
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{11111111-2222-3333-4444-555555555555}\r\n' +
      '    DistributionName    REG_SZ    '
  ),
  Buffer.from([0xbf, 0xaa, 0xb7, 0xa2, 0xbb, 0xb7, 0xbe, 0xb3]),
  Buffer.from('\r\n    Version    REG_DWORD    0x2\r\n\r\n')
])

it('reads a distro name that reg.exe printed in the console code page', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  runProcess.mockResolvedValue({
    code: 0,
    stdout: '',
    stdoutBytes: lxssDump,
    stderr: '',
    timedOut: false
  })

  expect(await readWslDistroRegistrations()).toEqual([
    { id: '11111111-2222-3333-4444-555555555555', distro: '开发环境', version: 2 }
  ])
})
