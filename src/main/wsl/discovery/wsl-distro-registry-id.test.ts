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

// `reg query <Lxss> /s` on a cp936 Windows: ASCII except the name, whose GBK bytes are also valid UTF-8.
const lxssDump = Buffer.concat([
  Buffer.from(
    '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\r\n' +
      '    DefaultDistribution    REG_SZ    {11111111-2222-3333-4444-555555555555}\r\n\r\n'
  ),
  Buffer.from(
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{11111111-2222-3333-4444-555555555555}\r\n' +
      '    DistributionName    REG_SZ    '
  ),
  Buffer.from([0xd1, 0xa7, 0xcf, 0xb0]),
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
    { id: '11111111-2222-3333-4444-555555555555', distro: '学习', version: 2 }
  ])
})
