import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { decodeWindowsShellOutput } from './windows-shell-output-decoding'

const { loadWindowsNativeRegistry, runProcess } = vi.hoisted(() => ({
  loadWindowsNativeRegistry: vi.fn(),
  runProcess: vi.fn()
}))

vi.mock('./windows-native-registry', () => ({ loadWindowsNativeRegistry }))
vi.mock('@orca/process-host', () => ({ runProcess }))

const originalPlatform = process.platform
const gbkCmdMessage = [0x27, 0x78, 0x27, 0x20, 0xd6, 0xd0, 0xce, 0xc4, 0x0d, 0x0a]
const utf8CutCharacter = Buffer.from('中', 'utf8').subarray(0, 2)

beforeEach(() => {
  loadWindowsNativeRegistry.mockReturnValue({
    HK: { CU: 1, LM: 2 },
    getRegistryKey: () => ({ OEMCP: { value: '936' } })
  })
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
})

it('decodes cmd.exe OEM lines and UTF-8 tool lines from one pipe', () => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  const utf8ToolLine = [...Buffer.from('中文 ok\n', 'utf8')]
  const bytes = Buffer.from([...gbkCmdMessage, ...utf8ToolLine, ...Buffer.from('tail')])

  expect(decodeWindowsShellOutput(bytes)).toBe("'x' 中文\r\n中文 ok\ntail")
})

it.each([
  { name: 'alone', prefix: [], expected: '中文 ok�' },
  { name: 'after a cmd.exe line', prefix: gbkCmdMessage, expected: "'x' 中文\r\n中文 ok�" }
])('keeps a UTF-8 line cut mid-character at the end as UTF-8 ($name)', ({ prefix, expected }) => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  const bytes = Buffer.from([...prefix, ...Buffer.from('中文 ok', 'utf8'), ...utf8CutCharacter])

  expect(decodeWindowsShellOutput(bytes)).toBe(expected)
})

it.each([
  {
    name: 'the addon is not installed',
    addon: () => {
      throw new Error("Cannot find module '@orca/windows-registry'")
    }
  },
  {
    // A dev tree or a bundle that ships the addon's JS without its binary.
    name: 'the addon cannot load its binary',
    addon: () => ({
      HK: { CU: 1, LM: 2 },
      getRegistryKey: () => {
        throw new Error("Cannot find module './build/Release/orca_windows_registry.node'")
      }
    })
  }
])('asks reg.exe for the page when $name', async ({ addon }) => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  loadWindowsNativeRegistry.mockImplementation(addon)
  runProcess.mockResolvedValue({
    code: 0,
    stdout:
      '\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage\r\n    OEMCP    REG_SZ    936\r\n\r\n'
  })
  vi.resetModules()
  const { decodeWindowsShellOutputAsync } = await import('./windows-shell-output-decoding')

  expect(await decodeWindowsShellOutputAsync(Buffer.from(gbkCmdMessage))).toBe("'x' 中文\r\n")
})
