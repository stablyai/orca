import { isUtf8 } from 'node:buffer'
import { runProcess } from '@orca/process-host'
import { windowsSystem32Binary } from '@orca/process-host/windows-system-binary'
import { loadWindowsNativeRegistry } from './windows-native-registry'

// cmd.exe and reg.exe write their own text to pipes in the OEM code page; these are the OEM pages TextDecoder supports.
const OEM_CODE_PAGE_ENCODINGS: Record<string, string> = {
  '866': 'ibm866',
  '874': 'windows-874',
  '932': 'shift_jis',
  '936': 'gbk',
  '949': 'euc-kr',
  '950': 'big5',
  '1258': 'windows-1258'
}
const OEM_CODE_PAGE_KEY = 'SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage'

let windowsOemDecoder: TextDecoder | null | undefined
let windowsOemPageKnown = false
let windowsOemDecoderWithoutAddon: Promise<TextDecoder | null> | undefined

function oemDecoderFor(codePage: unknown): TextDecoder | null {
  const encoding = typeof codePage === 'string' ? OEM_CODE_PAGE_ENCODINGS[codePage] : undefined
  return encoding ? new TextDecoder(encoding) : null
}

function readWindowsOemDecoder(): TextDecoder | null {
  if (windowsOemDecoder === undefined) {
    windowsOemDecoder = null
    try {
      const registry = loadWindowsNativeRegistry()
      const page = registry.getRegistryKey(registry.HK.LM, OEM_CODE_PAGE_KEY)?.OEMCP?.value
      // Known once the addon answered, even for a page TextDecoder lacks (reg.exe would name the same one).
      windowsOemPageKnown = true
      windowsOemDecoder = oemDecoderFor(page)
    } catch {
      // Without the registry addon the page stays unknown; without ICU support for it, decode as UTF-8.
    }
  }
  return windowsOemDecoder
}

/** Without the registry addon (server slots, the relay), reg.exe names the page in ASCII. */
function readWindowsOemDecoderWithoutAddon(): Promise<TextDecoder | null> {
  windowsOemDecoderWithoutAddon ??= runProcess({
    program: windowsSystem32Binary('reg.exe'),
    args: ['query', `HKLM\\${OEM_CODE_PAGE_KEY}`, '/v', 'OEMCP'],
    timeoutMs: 1_000
  }).then(
    ({ code, stdout }) => {
      try {
        return code === 0
          ? oemDecoderFor(/^\s*OEMCP\s+REG_SZ\s+(\d+)\s*$/im.exec(stdout)?.[1])
          : null
      } catch {
        return null
      }
    },
    () => null
  )
  return windowsOemDecoderWithoutAddon
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

function needsOemDecoder(bytes: Buffer): boolean {
  return process.platform === 'win32' && !isUtf8BeforeCutCharacter(bytes)
}

function decodeWith(oemDecoder: TextDecoder | null, bytes: Buffer): string {
  return oemDecoder ? decodeMixedShellOutputLines(bytes, oemDecoder) : bytes.toString('utf8')
}

export function decodeWindowsShellOutput(bytes: Buffer): string {
  // Check UTF-8 first so plain output never loads the registry addon.
  return decodeWith(needsOemDecoder(bytes) ? readWindowsOemDecoder() : null, bytes)
}

/** For callers that can await: where there is no registry addon (server slots, the relay), reg.exe names the page. */
export async function decodeWindowsShellOutputAsync(bytes: Buffer): Promise<string> {
  if (!needsOemDecoder(bytes)) {
    return bytes.toString('utf8')
  }
  const oemDecoder = readWindowsOemDecoder()
  return decodeWith(
    oemDecoder ?? (windowsOemPageKnown ? null : await readWindowsOemDecoderWithoutAddon()),
    bytes
  )
}
