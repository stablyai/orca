import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
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
    let entry: { name: string | null; noDisplay: boolean }
    try {
      entry = parseDesktopEntry(await readFile(desktopFilePath, 'utf8'))
    } catch {
      continue
    }
    if (entry.noDisplay) {
      continue
    }
    candidates.push({
      id: `linux:${desktopId}`,
      name: entry.name ?? desktopId.replace(/\.desktop$/, ''),
      isDefault: desktopId === defaultDesktopId,
      launch: { kind: 'linux-desktop-entry', desktopFilePath }
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

export function parseDesktopEntry(content: string): { name: string | null; noDisplay: boolean } {
  let inDesktopEntryGroup = false
  let name: string | null = null
  let noDisplay = false
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
  }
  return { name, noDisplay }
}
