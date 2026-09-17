import {
  CLIPBOARD_FILE_PATH_MAX_ENTRIES,
  parseClipboardFileUriList,
  parseMacOsFilenamesPropertyList
} from '../../shared/clipboard-file-paths'
import { isRuntimePathAbsolute } from '../../shared/cross-platform-path'

export const MACOS_FILENAMES_FORMAT = 'NSFilenamesPboardType'
export const MACOS_FILE_URL_FORMAT = 'public.file-url'
export const WINDOWS_FILE_NAME_FORMAT = 'FileNameW'
export const GNOME_COPIED_FILES_FORMAT = 'x-special/gnome-copied-files'
export const URI_LIST_FORMAT = 'text/uri-list'

// Injected so the platform branching is unit-testable without the real OS
// clipboard, matching clipboard-file-copy.ts.
export type ClipboardFilePathsDeps = {
  platform: NodeJS.Platform
  read: (format: string) => string
  readBuffer: (format: string) => Buffer
}

// Why: the flavors are read by their native names rather than filtered through
// `availableFormats()`, which reports Chromium's normalized MIME names — a
// macOS file copy advertises only `text/uri-list`, whose read is empty.
function readText(deps: ClipboardFilePathsDeps, format: string): string {
  try {
    const text = deps.read(format)
    if (text) {
      return text
    }
  } catch {
    // Fall through to the buffer flavor.
  }
  try {
    return deps.readBuffer(format).toString('utf8')
  } catch {
    return ''
  }
}

function readDarwinFilePaths(deps: ClipboardFilePathsDeps): string[] {
  // The legacy filenames list is the only flavor that carries every file of a
  // multi-file Finder copy; `public.file-url` exposes just the first item.
  const listedPaths = parseMacOsFilenamesPropertyList(readText(deps, MACOS_FILENAMES_FORMAT))
  if (listedPaths.length > 0) {
    return listedPaths
  }
  return parseClipboardFileUriList(readText(deps, MACOS_FILE_URL_FORMAT))
}

function readWin32FilePaths(deps: ClipboardFilePathsDeps): string[] {
  // Why: Electron exposes no CF_HDROP reader, so Explorer's compatibility
  // FileNameW flavor is the only path available — it carries the first file.
  let decoded: string
  try {
    decoded = deps.readBuffer(WINDOWS_FILE_NAME_FORMAT).toString('utf16le')
  } catch {
    return []
  }
  const path = decoded.split('\0')[0]?.trim() ?? ''
  return path && isRuntimePathAbsolute(path, 'windows') ? [path] : []
}

function readLinuxFilePaths(deps: ClipboardFilePathsDeps): string[] {
  // GNOME-family managers carry the copy/cut verb line; KDE writes a bare list.
  for (const format of [GNOME_COPIED_FILES_FORMAT, URI_LIST_FORMAT]) {
    const paths = parseClipboardFileUriList(readText(deps, format))
    if (paths.length > 0) {
      return paths
    }
  }
  return []
}

/**
 * Read the file entries an OS file manager put on the clipboard, as absolute
 * client-local paths. Returns an empty list when the clipboard holds no files.
 */
export function readClipboardFilePaths(deps: ClipboardFilePathsDeps): string[] {
  const paths =
    deps.platform === 'darwin'
      ? readDarwinFilePaths(deps)
      : deps.platform === 'win32'
        ? readWin32FilePaths(deps)
        : readLinuxFilePaths(deps)
  return paths.slice(0, CLIPBOARD_FILE_PATH_MAX_ENTRIES)
}
