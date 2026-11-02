import { runProcess } from '@orca/process-host'
import { listWindowsInstalledFontFamilies } from './windows-installed-font-families'

let cachedFonts: string[] | null = null
let fontsPromise: Promise<string[]> | null = null
const SYSTEM_FONT_LIST_TIMEOUT_MS = 15_000
// Large macOS font catalogs need more time in system_profiler.
const MAC_SYSTEM_FONT_LIST_TIMEOUT_MS = 45_000

/** Empty when the OS list is unreadable; the renderer then shows its curated fonts and says so. */
export async function listSystemFontFamilies(): Promise<string[]> {
  if (cachedFonts) {
    return cachedFonts
  }
  if (fontsPromise) {
    return fontsPromise
  }

  fontsPromise = loadSystemFontFamilies()
    .catch((error: unknown) => {
      console.warn('[system-fonts] failed to list installed fonts:', error)
      return []
    })
    .then((fonts) => {
      cachedFonts = fonts
      return fonts
    })
    .finally(() => {
      fontsPromise = null
    })

  return fontsPromise
}

function loadSystemFontFamilies(): Promise<string[]> {
  if (process.platform === 'darwin') {
    return listMacFonts()
  }
  if (process.platform === 'win32') {
    return listWindowsInstalledFontFamilies().then(uniqueSorted)
  }
  return listLinuxFonts()
}

function listMacFonts(): Promise<string[]> {
  return execFileText(
    'system_profiler',
    ['SPFontsDataType', '-json'],
    32 * 1024 * 1024,
    MAC_SYSTEM_FONT_LIST_TIMEOUT_MS
  ).then((output) => {
    const parsed = JSON.parse(output) as {
      SPFontsDataType?: {
        typefaces?: {
          family?: string
        }[]
      }[]
    }

    return uniqueSorted(
      (parsed.SPFontsDataType ?? []).flatMap((font) =>
        (font.typefaces ?? []).map((typeface) => typeface.family)
      )
    )
  })
}

function listLinuxFonts(): Promise<string[]> {
  return execFileText('fc-list', [':', 'family'], 8 * 1024 * 1024).then((output) =>
    uniqueSorted(
      output
        .split('\n')
        .flatMap((line) => line.split(','))
        .map((name) => name.trim())
        .filter(Boolean)
    )
  )
}

async function execFileText(
  command: string,
  args: string[],
  maxBuffer: number,
  timeoutMs = SYSTEM_FONT_LIST_TIMEOUT_MS
): Promise<string> {
  // A stuck OS font tool must not leave settings IPC pending forever.
  const result = await runProcess({
    program: command,
    args,
    timeoutMs,
    maxOutputBytes: maxBuffer
  })
  if (result.timedOut) {
    throw new Error(`Timed out listing system fonts with ${command}`)
  }
  if (result.code !== 0) {
    throw new Error(`Failed to list system fonts with ${command}`)
  }
  return result.stdout
}

function uniqueSorted(values: (string | undefined)[]): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => value?.trim() ?? '')
        .filter((value) => value.length > 0 && !value.startsWith('.'))
    )
  ).sort((a, b) => a.localeCompare(b))
}
