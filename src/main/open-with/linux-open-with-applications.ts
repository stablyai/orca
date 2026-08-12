import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { OpenWithApplicationCandidate } from './open-with-candidate'
import { readOpenWithCommandOutput } from './open-with-command-output'

export async function listLinuxOpenWithApplications(
  filePath: string
): Promise<OpenWithApplicationCandidate[]> {
  const mimeType = (
    await readOpenWithCommandOutput('xdg-mime', ['query', 'filetype', filePath])
  ).trim()
  if (!mimeType) {
    return []
  }
  const gioOutput = await readOpenWithCommandOutput('gio', ['mime', mimeType])
  const { defaultDesktopId, desktopIds } = parseGioMimeApplications(gioOutput)

  const candidates: OpenWithApplicationCandidate[] = []
  const seenDesktopIds = new Set<string>()
  const orderedIds = defaultDesktopId ? [defaultDesktopId, ...desktopIds] : desktopIds
  for (const desktopId of orderedIds) {
    if (seenDesktopIds.has(desktopId)) {
      continue
    }
    seenDesktopIds.add(desktopId)
    const desktopFilePath = findDesktopFilePath(desktopId)
    if (!desktopFilePath) {
      continue
    }
    let entry: ReturnType<typeof parseDesktopEntry>
    try {
      entry = parseDesktopEntry(await readFile(desktopFilePath, 'utf8'))
    } catch {
      continue
    }
    // Why: Terminal=true entries need a terminal emulator we cannot attach.
    if (entry.noDisplay || entry.terminal) {
      continue
    }
    const execTokens = entry.exec ? parseLinuxExecTokens(entry.exec) : null
    if (!execTokens) {
      continue
    }
    candidates.push({
      id: `linux:${desktopId}`,
      name: entry.name ?? desktopId.replace(/\.desktop$/, ''),
      isDefault: desktopId === defaultDesktopId,
      launch: { kind: 'linux-desktop-entry', execTokens }
    })
  }
  return candidates
}

export function parseGioMimeApplications(output: string): {
  defaultDesktopId: string | null
  desktopIds: string[]
} {
  let defaultDesktopId: string | null = null
  const desktopIds: string[] = []
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.endsWith(':')) {
      continue
    }
    const defaultMatch = /^Default application for .*:\s*(\S+\.desktop)$/.exec(line)
    if (defaultMatch) {
      defaultDesktopId = defaultMatch[1]
      continue
    }
    if (line.endsWith('.desktop')) {
      desktopIds.push(line)
    }
  }
  return { defaultDesktopId, desktopIds }
}

function getLinuxApplicationDirectories(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME ?? ''
  const dataHome = env.XDG_DATA_HOME?.trim() || (home ? join(home, '.local', 'share') : '')
  const dataDirs = (env.XDG_DATA_DIRS?.trim() || '/usr/local/share:/usr/share').split(':')
  return [dataHome, ...dataDirs]
    .map((dir) => dir.trim())
    .filter(Boolean)
    .map((dir) => join(dir, 'applications'))
}

function findDesktopFilePath(desktopId: string): string | null {
  for (const directory of getLinuxApplicationDirectories()) {
    const directPath = join(directory, desktopId)
    if (existsSync(directPath)) {
      return directPath
    }
    // Why: desktop ids encode subdirectories as dashes (kde4-kate.desktop can
    // live at applications/kde4/kate.desktop).
    const dashIndex = desktopId.indexOf('-')
    if (dashIndex > 0) {
      const nestedPath = join(
        directory,
        desktopId.slice(0, dashIndex),
        desktopId.slice(dashIndex + 1)
      )
      if (existsSync(nestedPath)) {
        return nestedPath
      }
    }
  }
  return null
}

export function parseDesktopEntry(content: string): {
  name: string | null
  noDisplay: boolean
  exec: string | null
  terminal: boolean
} {
  let inDesktopEntryGroup = false
  let name: string | null = null
  let noDisplay = false
  let exec: string | null = null
  let terminal = false
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (line.startsWith('[')) {
      inDesktopEntryGroup = line === '[Desktop Entry]'
      continue
    }
    if (!inDesktopEntryGroup) {
      continue
    }
    if (name === null && line.startsWith('Name=')) {
      name = line.slice('Name='.length).trim() || null
    }
    if (line.startsWith('NoDisplay=')) {
      noDisplay = line.slice('NoDisplay='.length).trim() === 'true'
    }
    if (exec === null && line.startsWith('Exec=')) {
      exec = line.slice('Exec='.length).trim() || null
    }
    if (line.startsWith('Terminal=')) {
      terminal = line.slice('Terminal='.length).trim() === 'true'
    }
  }
  return { name, noDisplay, exec, terminal }
}

// Why: `gio launch` needs GLib 2.67.2+, newer than the Ubuntu 20.04 floor, so
// Orca runs the Exec line itself: freedesktop quoting rules, the file path kept
// as its own argv element, never a shell.
export function parseLinuxExecTokens(exec: string): string[] | null {
  const tokens: string[] = []
  let current: string | null = null
  let inQuotes = false
  for (let index = 0; index < exec.length; index++) {
    const char = exec[index]
    if (inQuotes) {
      if (char === '"') {
        inQuotes = false
      } else if (char === '\\' && index + 1 < exec.length) {
        current = (current ?? '') + exec[++index]
      } else {
        current = (current ?? '') + char
      }
      continue
    }
    if (char === '"') {
      inQuotes = true
      current ??= ''
      continue
    }
    if (char === ' ' || char === '\t') {
      if (current !== null) {
        tokens.push(current)
        current = null
      }
      continue
    }
    current = (current ?? '') + char
  }
  if (current !== null) {
    tokens.push(current)
  }
  return tokens.length > 0 ? tokens : null
}

export function buildLinuxLaunchInvocation(
  execTokens: string[],
  filePath: string
): { spawnCmd: string; spawnArgs: string[] } | null {
  const args: string[] = []
  let usedFilePath = false
  for (const token of execTokens) {
    const substituted = substituteExecFieldCodes(token, filePath)
    if (substituted === null) {
      continue
    }
    usedFilePath ||= substituted.usedFilePath
    args.push(substituted.value)
  }
  if (args.length === 0) {
    return null
  }
  // Why: entries without a file field code still receive the file, matching
  // gio/gtk-launch behavior.
  if (!usedFilePath) {
    args.push(filePath)
  }
  return { spawnCmd: args[0], spawnArgs: args.slice(1) }
}

function substituteExecFieldCodes(
  token: string,
  filePath: string
): { value: string; usedFilePath: boolean } | null {
  let value = ''
  let usedFilePath = false
  let droppedFieldCode = false
  for (let index = 0; index < token.length; index++) {
    const char = token[index]
    if (char !== '%' || index + 1 >= token.length) {
      value += char
      continue
    }
    const code = token[++index]
    if (code === '%') {
      value += '%'
    } else if (code === 'f' || code === 'F') {
      value += filePath
      usedFilePath = true
    } else if (code === 'u' || code === 'U') {
      // Why: %u/%U handlers declare URI support; %f handlers get a plain path.
      value += pathToFileURL(filePath).href
      usedFilePath = true
    } else {
      // Why: %i/%c/%k and the deprecated codes expand to nothing here.
      droppedFieldCode = true
    }
  }
  if (value === '' && droppedFieldCode) {
    return null
  }
  return { value, usedFilePath }
}
