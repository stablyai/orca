import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

// Injected so the platform branching is unit-testable without the real OS
// clipboard or spawning processes. Mirrors clipboard-file-copy.ts.
export type ClipboardPasteDeps = {
  platform: NodeJS.Platform
  readBuffer: (format: string) => Buffer
  runCommandForOutput: (command: string, args: string[]) => Promise<string>
}

function parseFileUriList(raw: string): string[] {
  const paths: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    // gnome-copied-files leads with the operation verb; uri-list allows comments.
    if (!trimmed || trimmed === 'copy' || trimmed === 'cut' || trimmed.startsWith('#')) {
      continue
    }
    if (!trimmed.startsWith('file://')) {
      continue
    }
    try {
      paths.push(fileURLToPath(trimmed))
    } catch {
      // Skip malformed URIs rather than failing the whole read.
    }
  }
  return paths
}

function dedupeAbsolute(paths: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const path of paths) {
    if (!path || !isAbsolute(path) || seen.has(path)) {
      continue
    }
    seen.add(path)
    out.push(path)
  }
  return out
}

/** Read file references from the OS clipboard (the inverse of
 *  writeFileToClipboard). Never throws — an empty array means "nothing
 *  pastable", which callers use to hide the Paste affordance. */
export async function readClipboardFilePaths(deps: ClipboardPasteDeps): Promise<string[]> {
  try {
    if (deps.platform === 'win32') {
      // Get-Clipboard -Format FileDropList reads CF_HDROP — the same format
      // Explorer and our own Copy write. One path per line. The OutputEncoding
      // override is required: PowerShell 5.1 writes redirected stdout in the
      // OEM code page, which mojibakes any non-ASCII filename before it
      // reaches our UTF-8 decode.
      const output = await deps.runCommandForOutput('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); (Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }) -join "`n"'
      ])
      return dedupeAbsolute(output.split(/\r?\n/).map((line) => line.trim()))
    }
    if (deps.platform === 'darwin') {
      // Finder writes public.file-url; Electron exposes only the first entry.
      const buffer = deps.readBuffer('public.file-url')
      const href = buffer.toString('utf8').trim()
      return href.startsWith('file://') ? dedupeAbsolute([fileURLToPath(href)]) : []
    }
    // Linux: prefer the GNOME-family format (carries the verb), fall back to
    // the generic uri-list KDE and others write.
    const gnome = deps.readBuffer('x-special/gnome-copied-files').toString('utf8')
    const fromGnome = parseFileUriList(gnome)
    if (fromGnome.length > 0) {
      return dedupeAbsolute(fromGnome)
    }
    const uriList = deps.readBuffer('text/uri-list').toString('utf8')
    return dedupeAbsolute(parseFileUriList(uriList))
  } catch {
    return []
  }
}
