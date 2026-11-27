import { isUtf8 } from 'node:buffer'
import { loadWindowsNativeRegistry } from './windows-native-registry'

// cmd.exe writes its own messages to pipes in the OEM code page; these are the OEM pages TextDecoder supports.
const OEM_CODE_PAGE_ENCODINGS: Record<string, string> = {
  '866': 'ibm866',
  '874': 'windows-874',
  '932': 'shift_jis',
  '936': 'gbk',
  '949': 'euc-kr',
  '950': 'big5',
  '1258': 'windows-1258'
}

let windowsOemDecoder: TextDecoder | null | undefined

function readWindowsOemDecoder(): TextDecoder | null {
  if (windowsOemDecoder === undefined) {
    windowsOemDecoder = null
    try {
      const registry = loadWindowsNativeRegistry()
      const codePage = registry.getRegistryKey(
        registry.HK.LM,
        'SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage'
      )?.OEMCP?.value
      const encoding = typeof codePage === 'string' ? OEM_CODE_PAGE_ENCODINGS[codePage] : undefined
      windowsOemDecoder = encoding ? new TextDecoder(encoding) : null
    } catch {
      // No registry addon (server slots) or no ICU support for the page: decode as UTF-8.
    }
  }
  return windowsOemDecoder
}

// Output cut mid-character by a kill or flush stays UTF-8 rather than turning its whole line into OEM text.
function isUtf8BeforeCutCharacter(bytes: Buffer): boolean {
  for (let length = 1; length <= Math.min(3, bytes.length); length++) {
    const byte = bytes[bytes.length - length]
    if ((byte & 0xc0) !== 0x80) {
      const characterLength = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1
      const cutLength = characterLength > length ? length : 0
      return isUtf8(bytes.subarray(0, bytes.length - cutLength))
    }
  }
  return isUtf8(bytes)
}

/** Decodes each line as UTF-8 when valid, else with `oemDecoder`: one pipe can mix UTF-8 tools and cmd.exe messages. */
function decodeMixedShellOutputLines(bytes: Buffer, oemDecoder: TextDecoder): string {
  const lines: string[] = []
  let lineStart = 0
  for (let index = 0; index <= bytes.length; index++) {
    if (index < bytes.length && bytes[index] !== 0x0a) {
      continue
    }
    const line = bytes.subarray(lineStart, index)
    const utf8 = index === bytes.length ? isUtf8BeforeCutCharacter(line) : isUtf8(line)
    lines.push(utf8 ? line.toString('utf8') : oemDecoder.decode(line))
    lineStart = index + 1
  }
  return lines.join('\n')
}

export function decodeWindowsShellOutput(bytes: Buffer): string {
  // Check UTF-8 first so plain output never loads the registry addon.
  const oemDecoder =
    process.platform === 'win32' && !isUtf8BeforeCutCharacter(bytes)
      ? readWindowsOemDecoder()
      : null
  return oemDecoder ? decodeMixedShellOutputLines(bytes, oemDecoder) : bytes.toString('utf8')
}
