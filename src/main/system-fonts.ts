import { execFile } from 'child_process'

let cachedFonts: string[] | null = null
let fontsPromise: Promise<string[]> | null = null

export async function listSystemFontFamilies(): Promise<string[]> {
  if (cachedFonts) {
    return cachedFonts
  }
  if (fontsPromise) {
    return fontsPromise
  }

  fontsPromise = loadSystemFontFamilies()
    .then((fonts) => {
      cachedFonts = fonts.length > 0 ? fonts : fallbackFonts()
      return cachedFonts
    })
    .catch(() => {
      cachedFonts = fallbackFonts()
      return cachedFonts
    })
    .finally(() => {
      fontsPromise = null
    })

  return fontsPromise
}

export function warmSystemFontFamilies(): void {
  void listSystemFontFamilies()
}

function loadSystemFontFamilies(): Promise<string[]> {
  if (process.platform === 'darwin') {
    return listMacFonts()
  }
  if (process.platform === 'win32') {
    return listWindowsFonts()
  }
  return listLinuxFonts()
}

function listMacFonts(): Promise<string[]> {
  return execFileText('system_profiler', ['SPFontsDataType', '-json'], 32 * 1024 * 1024).then(
    (output) => {
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
    }
  )
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

function listWindowsFonts(): Promise<string[]> {
  const script = `
Add-Type -AssemblyName System.Drawing
$fonts = New-Object System.Drawing.Text.InstalledFontCollection
$fonts.Families | ForEach-Object { $_.Name }
`

  return execFileText(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    8 * 1024 * 1024
  ).then((output) =>
    uniqueSorted(
      output
        .split('\n')
        .map((name) => name.trim())
        .filter(Boolean)
    )
  )
}

function execFileText(command: string, args: string[], maxBuffer: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', maxBuffer }, (error, stdout) => {
      if (error) {
        reject(error)
        return
      }
      resolve(stdout)
    })
  })
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

function fallbackFonts(): string[] {
  if (process.platform === 'darwin') {
    return ['SF Mono', 'Menlo', 'Monaco', 'JetBrains Mono', 'Fira Code']
  }
  if (process.platform === 'win32') {
    return ['Cascadia Mono', 'Consolas', 'Lucida Console', 'JetBrains Mono', 'Fira Code']
  }
  return [
    'JetBrains Mono',
    'Fira Code',
    'DejaVu Sans Mono',
    'Liberation Mono',
    'Ubuntu Mono',
    'Noto Sans Mono'
  ]
}
