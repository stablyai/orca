import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

export type ClipboardFileResult = { ok: boolean; reason?: string }

// Injected so the platform branching is unit-testable without the real OS
// clipboard or spawning processes.
export type ClipboardFileDeps = {
  platform: NodeJS.Platform
  // Linux only: the active desktop ($XDG_CURRENT_DESKTOP). KDE and GNOME-family
  // file managers disagree on the clipboard format, so it picks the payload.
  desktop?: string
  resolveFilePath: (
    path: string
  ) => Promise<{ ok: true; path: string } | { ok: false; reason: string }>
  writeBuffer: (format: string, buffer: Buffer) => void
  runCommand: (command: string, args: string[], stdin?: string) => Promise<void>
}

// Put a real OS-level file reference on the clipboard so pasting in Finder /
// Explorer / a file manager drops the actual file (not its path as text). Only
// local files work — remote/SSH files don't exist on this machine. Always
// resolves a result and never throws, so the renderer can report failures.
export async function writeFileToClipboard(
  filePath: string,
  deps: ClipboardFileDeps
): Promise<ClipboardFileResult> {
  if (typeof filePath !== 'string' || !isAbsolute(filePath)) {
    return { ok: false, reason: 'invalid-path' }
  }
  const resolvedFile = await deps.resolveFilePath(filePath)
  if (!resolvedFile.ok) {
    return { ok: false, reason: resolvedFile.reason }
  }
  const clipboardPath = resolvedFile.path

  if (deps.platform === 'darwin') {
    // macOS reads `public.file-url` and synthesizes the legacy file types Finder
    // needs, so a single buffer is enough.
    try {
      deps.writeBuffer('public.file-url', Buffer.from(pathToFileURL(clipboardPath).href, 'utf8'))
      return { ok: true }
    } catch {
      return { ok: false, reason: 'clipboard-write-failed' }
    }
  }

  if (deps.platform === 'win32') {
    // Set-Clipboard -LiteralPath populates CF_HDROP, which Explorer pastes as a
    // file. Single-quote escaping for the PowerShell string literal. Guard the
    // spawn so a missing/erroring PowerShell surfaces as a result, not a throw.
    const escaped = clipboardPath.replace(/'/g, "''")
    try {
      await deps.runCommand('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Set-Clipboard -LiteralPath '${escaped}'`
      ])
      return { ok: true }
    } catch {
      return { ok: false, reason: 'clipboard-command-failed' }
    }
  }

  // Linux: best-effort and desktop-dependent. GNOME-family managers
  // (Nautilus/Nemo/Caja) read the "copied-files" payload that carries the
  // explicit copy verb; KDE/Qt managers (Dolphin) read text/uri-list instead.
  const fileUrl = pathToFileURL(clipboardPath).href
  const [mime, payload] = /kde/i.test(deps.desktop ?? '')
    ? ['text/uri-list', `${fileUrl}\r\n`]
    : ['x-special/gnome-copied-files', `copy\n${fileUrl}`]
  for (const [command, args] of [
    ['wl-copy', ['--type', mime]],
    ['xclip', ['-selection', 'clipboard', '-t', mime]]
  ] as const) {
    try {
      await deps.runCommand(command, [...args], payload)
      return { ok: true }
    } catch {
      // try the next tool
    }
  }
  return { ok: false, reason: 'unsupported-platform' }
}
