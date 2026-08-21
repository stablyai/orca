import { execFile } from 'node:child_process'

let cachedFonts: string[] | null = null
let fontsPromise: Promise<string[]> | null = null
const SYSTEM_FONT_LIST_TIMEOUT_MS = 15_000
// Why: large macOS font catalogs can make system_profiler exceed 15s even
// when it is healthy; keep the longer wait scoped to that slow command.
const MAC_SYSTEM_FONT_LIST_TIMEOUT_MS = 45_000

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

// Why: the machine PATH resolves powershell.exe to the 5.1 launcher that Group
// Policy can block. Prefer pwsh (PowerShell 7), then the absolute 5.1 path so
// PATH resolution never decides the outcome (GH-11771).
function windowsPowerShellCandidates(): string[] {
  const windir = process.env.WINDIR ?? 'C:\\Windows'
  return ['pwsh.exe', `${windir}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`]
}

// Why: a blocked or missing first candidate must not fail the whole lookup;
// try each command in order and surface only the last error once all failed.
async function execFileTextFirst(
  commands: string[],
  args: string[],
  maxBuffer: number,
  timeoutMs = SYSTEM_FONT_LIST_TIMEOUT_MS
): Promise<string> {
  let lastError: unknown
  for (const command of commands) {
    try {
      return await execFileText(command, args, maxBuffer, timeoutMs)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

function listWindowsFonts(): Promise<string[]> {
  // Why: PowerShell 5.1 emits redirected stdout in the OEM code page; pin UTF-8
  // before the first name is written or localized families arrive as mojibake (#12590).
  const script = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Drawing
$fonts = New-Object System.Drawing.Text.InstalledFontCollection
$fonts.Families | ForEach-Object { $_.Name }
`

  return execFileTextFirst(
    windowsPowerShellCandidates(),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    8 * 1024 * 1024
  )
    .then((output) =>
      uniqueSorted(
        output
          .split('\n')
          .map((name) => name.trim())
          .filter(Boolean)
      )
    )
    .catch((error: unknown) => {
      // Why: a GP-blocked PowerShell used to degrade to 5 hardcoded fonts with
      // no trace; surface the real spawn error so managed hosts are diagnosable.
      console.warn('[system-fonts] failed to enumerate Windows fonts, using fallback:', error)
      throw error
    })
}

function execFileText(
  command: string,
  args: string[],
  maxBuffer: number,
  timeoutMs = SYSTEM_FONT_LIST_TIMEOUT_MS
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const child = execFile(command, args, { encoding: 'utf8', maxBuffer }, (error, stdout) => {
      if (settled) {
        return
      }
      settled = true
      if (timer) {
        clearTimeout(timer)
      }
      if (error) {
        reject(error)
        return
      }
      resolve(stdout)
    })
    if (!settled) {
      timer = setTimeout(() => {
        if (settled) {
          return
        }
        settled = true
        // Why: font discovery is a startup convenience; a stuck OS font tool
        // should fall back instead of keeping settings IPC pending forever.
        child.kill()
        reject(new Error(`Timed out listing system fonts with ${command}`))
      }, timeoutMs)
      if (typeof timer === 'object' && 'unref' in timer) {
        timer.unref()
      }
    }
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
