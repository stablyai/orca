import { afterEach, expect, it, vi } from 'vitest'
import { decodeWindowsShellOutput } from './windows-shell-output-decoding'

vi.mock('./windows-native-registry', () => ({
  loadWindowsNativeRegistry: () => ({
    HK: { CU: 1, LM: 2 },
    getRegistryKey: () => ({ OEMCP: { value: '936' } })
  })
}))

const originalPlatform = process.platform
const gbkCmdMessage = [0x27, 0x78, 0x27, 0x20, 0xd6, 0xd0, 0xce, 0xc4, 0x0d, 0x0a]
const utf8CutCharacter = Buffer.from('中', 'utf8').subarray(0, 2)

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
