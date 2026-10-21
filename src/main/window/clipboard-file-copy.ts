import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'
import { windowsPowerShellPath } from '@orca/process-host/windows-system-binary'

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
  runProcess: (spec: ProcessSpec) => Promise<ProcessResult>
}

const WINDOWS_CLIPBOARD_FILE_ENV = 'ORCA_CLIPBOARD_FILE'

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
    // Set-Clipboard publishes CF_HDROP; Electron's writeBuffer only registers custom formats Explorer can't paste.
    // The path travels in the environment so it is never parsed as script.
    const copied = await runClipboardHelper(deps.runProcess, {
      program: windowsPowerShellPath(),
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Set-Clipboard -LiteralPath $env:${WINDOWS_CLIPBOARD_FILE_ENV}`
      ],
      env: { ...process.env, [WINDOWS_CLIPBOARD_FILE_ENV]: clipboardPath }
    })
    return copied ? { ok: true } : { ok: false, reason: 'clipboard-command-failed' }
  }

  // Linux: best-effort and desktop-dependent. GNOME-family managers
  // (Nautilus/Nemo/Caja) read the "copied-files" payload that carries the
  // explicit copy verb; KDE/Qt managers (Dolphin) read text/uri-list instead.
  const fileUrl = pathToFileURL(clipboardPath).href
  const [mime, payload] = /kde/i.test(deps.desktop ?? '')
    ? ['text/uri-list', `${fileUrl}\r\n`]
    : ['x-special/gnome-copied-files', `copy\n${fileUrl}`]
  for (const [program, args] of [
    ['wl-copy', ['--type', mime]],
    ['xclip', ['-selection', 'clipboard', '-t', mime]]
  ] as const) {
    if (await runClipboardHelper(deps.runProcess, { program, args, input: payload })) {
      return { ok: true }
    }
  }
  return { ok: false, reason: 'unsupported-platform' }
}

// True only on a clean exit; a helper that cannot start, fails or times out is false.
async function runClipboardHelper(
  runProcess: ClipboardFileDeps['runProcess'],
  spec: ProcessSpec
): Promise<boolean> {
  try {
    const result = await runProcess({
      ...spec,
      // Why ignored: wl-copy and xclip fork a background selection owner, and an
      // inherited output pipe would hold the run open until that owner exits.
      stdio: ['pipe', 'ignore', 'ignore']
    })
    return result.code === 0 && !result.timedOut
  } catch {
    return false
  }
}
