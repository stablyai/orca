import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'
import { windowsPowerShellPath } from '@orca/process-host/windows-system-binary'
import { withTimeout } from '../../shared/promise-timeout-fallback'

export type ClipboardFileResult = { ok: boolean; reason?: string }

// Inject OS clipboard/process boundaries for platform tests.
export type ClipboardFileDeps = {
  platform: NodeJS.Platform
  // Linux XDG_CURRENT_DESKTOP selects KDE URI lists versus GNOME copied-files payloads.
  desktop?: string
  resolveFilePath: (
    path: string
  ) => Promise<{ ok: true; path: string } | { ok: false; reason: string }>
  writeBuffer: (format: string, buffer: Buffer) => void
  runProcess: (spec: ProcessSpec) => Promise<ProcessResult>
}

const WINDOWS_CLIPBOARD_FILE_ENV = 'ORCA_CLIPBOARD_FILE'
export const CLIPBOARD_FILE_RESOLUTION_TIMEOUT_MS = 5_000

// Publish local OS file references for file-manager paste; remote files are unavailable here. Return clipboard failures to the renderer.
export async function writeFileToClipboard(
  filePath: string,
  deps: ClipboardFileDeps
): Promise<ClipboardFileResult> {
  if (typeof filePath !== 'string' || !isAbsolute(filePath)) {
    return { ok: false, reason: 'invalid-path' }
  }
  // Copies share one ordered queue, so a hung mount must not block every later clipboard write.
  const resolvedFile = await withTimeout(
    deps.resolveFilePath(filePath),
    CLIPBOARD_FILE_RESOLUTION_TIMEOUT_MS,
    { ok: false, reason: 'clipboard-write-failed' }
  )
  if (!resolvedFile.ok) {
    return { ok: false, reason: resolvedFile.reason }
  }
  const clipboardPath = resolvedFile.path

  if (deps.platform === 'darwin') {
    // macOS synthesizes Finder's legacy types from public.file-url.
    try {
      deps.writeBuffer('public.file-url', Buffer.from(pathToFileURL(clipboardPath).href, 'utf8'))
      return { ok: true }
    } catch {
      return { ok: false, reason: 'clipboard-write-failed' }
    }
  }

  if (deps.platform === 'win32') {
    // Set-Clipboard publishes CF_HDROP, unlike Electron's custom formats; pass the literal path via environment to avoid script parsing.
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

  // KDE expects text/uri-list; GNOME-family file managers need copied-files with an explicit copy verb.
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
      // wl-copy/xclip fork selection owners; inherited output pipes would keep the request open until owner exit.
      stdio: ['pipe', 'ignore', 'ignore']
    })
    return result.code === 0 && !result.timedOut
  } catch {
    return false
  }
}
