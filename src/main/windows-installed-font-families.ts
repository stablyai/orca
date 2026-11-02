import { readdir } from 'node:fs/promises'
import { win32 as pathWin32 } from 'node:path'
import { windowsFontsDirectory } from '@orca/process-host/windows-system-binary'
import { mapSettledWithConcurrency } from '../shared/map-with-concurrency'
import { loadWindowsNativeRegistry } from './windows-native-registry'
import { readSfntFamilyNames } from './sfnt-family-names'

const FONTS_REGISTRY_KEY = 'Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'
// Bitmap .fon/.fnt fonts are registered too, but Chromium cannot render them.
const OUTLINE_FONT_FILE = /\.(?:ttf|ttc|otf|otc)$/i
const FONT_FILE_READ_CONCURRENCY = 16

// Reads font files natively; PowerShell can be blocked by Group Policy or constrained language mode.
export async function listWindowsInstalledFontFamilies(): Promise<string[]> {
  const files = readRegistryFontFiles() ?? (await readFontDirectoryFiles())
  const results = await mapSettledWithConcurrency(
    files,
    FONT_FILE_READ_CONCURRENCY,
    readSfntFamilyNames
  )
  return results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
}

/** Null when the registry is unreadable, so callers fall back to scanning the font directories. */
function readRegistryFontFiles(): string[] | null {
  try {
    const registry = loadWindowsNativeRegistry()
    const keys = [
      registry.getRegistryKey(registry.HK.LM, FONTS_REGISTRY_KEY),
      registry.getRegistryKey(registry.HK.CU, FONTS_REGISTRY_KEY)
    ]
    if (keys.every((values) => !values)) {
      return null
    }
    const fontsDirectory = windowsFontsDirectory()
    return uniqueFontFiles(
      keys.flatMap((values) =>
        Object.values(values ?? {}).map((entry) =>
          typeof entry?.value === 'string' ? pathWin32.resolve(fontsDirectory, entry.value) : ''
        )
      )
    )
  } catch {
    return null
  }
}

async function readFontDirectoryFiles(): Promise<string[]> {
  const directories = [windowsFontsDirectory()]
  if (process.env.LOCALAPPDATA) {
    directories.push(pathWin32.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts'))
  }
  const listings = await Promise.all(
    directories.map((directory) =>
      readdir(directory).then(
        (names) => names.map((name) => pathWin32.join(directory, name)),
        () => []
      )
    )
  )
  return uniqueFontFiles(listings.flat())
}

function uniqueFontFiles(paths: string[]): string[] {
  const files = new Map<string, string>()
  for (const path of paths) {
    const trimmed = path.trim()
    if (OUTLINE_FONT_FILE.test(trimmed)) {
      files.set(trimmed.toLowerCase(), trimmed)
    }
  }
  return [...files.values()]
}
