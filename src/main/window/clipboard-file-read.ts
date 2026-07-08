import { fileUriToFilesystemPath } from '../../shared/file-uri-path'

// Injected so the platform branching is unit-testable without the real OS
// clipboard or spawning processes. The READ mirror of clipboard-file-copy.ts.
export type ClipboardFileReadDeps = {
  platform: NodeJS.Platform
  // Linux only: the active desktop ($XDG_CURRENT_DESKTOP). KDE and GNOME-family
  // file managers disagree on the clipboard format, so it picks the payload.
  desktop?: string
  readFormat: (format: string) => string
  readBuffer: (format: string) => Buffer
  runCommand: (command: string, args: string[]) => Promise<string>
}

// Read the OS-level file references currently on the clipboard and return their
// absolute filesystem paths (empty when none). This is what lets a paste behave
// like a drop: a file copied in Finder/Explorer/a file manager pastes its full
// path, not the display name macOS synthesizes as clipboard text. Best-effort
// on every platform — always resolves and never throws.
export async function readClipboardFilePaths(deps: ClipboardFileReadDeps): Promise<string[]> {
  if (deps.platform === 'darwin') {
    // Why: Finder writes NSFilenamesPboardType — a plist array of the REAL POSIX
    // paths — for every file copy, so prefer it. It also covers multi-select.
    // public.file-url is only a fallback because Finder often puts an opaque
    // `file:///.file/id=…` reference there that POSIX path resolution cannot
    // resolve; the OS-synthesized display-name text is never a usable path.
    try {
      const names = parseFilenamesPlist(deps.readFormat('NSFilenamesPboardType'))
      if (names.length > 0) {
        return names
      }
    } catch {
      // fall through to public.file-url
    }
    let fileUrl = ''
    try {
      fileUrl = deps.readFormat('public.file-url')
    } catch {
      return []
    }
    const path = fileUrl ? fileUrlToFilesystemPath(fileUrl) : null
    // Why: an unresolved `/.file/id=` reference is not shell-usable, so skip it
    // and let paste fall through rather than insert an opaque reference.
    if (!path || path.startsWith('/.file/')) {
      return []
    }
    return [path]
  }

  if (deps.platform === 'win32') {
    // Read CF_HDROP via PowerShell (mirrors the Set-Clipboard write path). Guard
    // the spawn so a missing/erroring PowerShell yields [] instead of throwing.
    try {
      const output = await deps.runCommand('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }'
      ])
      return parseNewlineSeparatedPaths(output)
    } catch {
      return []
    }
  }

  // Linux: best-effort and desktop-dependent, mirroring the copy module's split.
  // GNOME-family managers (Nautilus/Nemo/Caja) carry the "copied-files" payload
  // (a leading copy/cut verb); KDE/Qt managers (Dolphin) use text/uri-list. Try
  // the desktop's preferred format first, then fall back to the other.
  const formats = /kde/i.test(deps.desktop ?? '')
    ? ['text/uri-list', 'x-special/gnome-copied-files']
    : ['x-special/gnome-copied-files', 'text/uri-list']
  for (const format of formats) {
    try {
      const paths = parseFileUriLines(deps.readBuffer(format).toString('utf8'))
      if (paths.length > 0) {
        return paths
      }
    } catch {
      // try the next format
    }
  }
  return []
}

function fileUrlToFilesystemPath(fileUrl: string): string | null {
  let url: URL
  try {
    url = new URL(fileUrl.trim())
  } catch {
    return null
  }
  return fileUriToFilesystemPath(url)
}

// NSFilenamesPboardType is an XML plist holding an <array> of <string> POSIX
// paths. Node has no plist parser, but the shape is fixed, so pull the string
// entries and XML-unescape them. Only absolute paths are kept.
function parseFilenamesPlist(plist: string): string[] {
  if (!plist) {
    return []
  }
  const paths: string[] = []
  const stringEntry = /<string>([\s\S]*?)<\/string>/g
  let match: RegExpExecArray | null
  while ((match = stringEntry.exec(plist)) !== null) {
    const path = unescapeXml(match[1]).trim()
    if (path.startsWith('/')) {
      paths.push(path)
    }
  }
  return paths
}

// Unescape the five XML predefined entities. `&amp;` is resolved last so an
// escaped entity like `&amp;lt;` in a filename survives as the literal `&lt;`.
function unescapeXml(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
}

function parseNewlineSeparatedPaths(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

// The "copied-files" payload's leading `copy`/`cut` verb and uri-list `#`
// comments are not file URIs, so filtering to `file:` lines drops them.
function parseFileUriLines(payload: string): string[] {
  const paths: string[] = []
  for (const line of payload.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('file:')) {
      continue
    }
    const path = fileUrlToFilesystemPath(trimmed)
    if (path) {
      paths.push(path)
    }
  }
  return paths
}
