import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DetectedBrowser } from './installed-browser-catalog'

const HTTPS_HANDLER_MIME_TYPE = 'x-scheme-handler/https'
const URL_FIELD_CODES = new Set(['%u', '%U', '%f', '%F'])
const DESKTOP_STRING_ESCAPES: Record<string, string> = {
  s: ' ',
  n: '\n',
  t: '\t',
  r: '\r',
  '\\': '\\'
}

type DesktopEntryFile = { id: string; text: string }

function unescapeDesktopString(value: string): string {
  return value.replace(/\\(.)/g, (match, char: string) => DESKTOP_STRING_ESCAPES[char] ?? match)
}

/** Unlocalized keys of the `[Desktop Entry]` group. */
function parseDesktopEntryGroup(text: string): Map<string, string> {
  const entries = new Map<string, string>()
  let inDesktopEntry = false
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.startsWith('[')) {
      inDesktopEntry = line === '[Desktop Entry]'
      continue
    }
    const separator = line.indexOf('=')
    if (!inDesktopEntry || line.startsWith('#') || separator <= 0) {
      continue
    }
    const key = line.slice(0, separator).trim()
    if (!entries.has(key)) {
      entries.set(key, line.slice(separator + 1).trim())
    }
  }
  return entries
}

/** Splits an Exec value into tokens per the Desktop Entry spec's quoting rules. */
function tokenizeDesktopExec(exec: string): { value: string; quoted: boolean }[] {
  const tokens: { value: string; quoted: boolean }[] = []
  let value = ''
  let quoted = false
  let inToken = false
  let inQuotes = false
  for (let index = 0; index < exec.length; index++) {
    const char = exec[index]
    if (inQuotes) {
      if (char === '"') {
        inQuotes = false
      } else if (char === '\\' && index + 1 < exec.length) {
        value += exec[++index]
      } else {
        value += char
      }
    } else if (/\s/.test(char)) {
      if (inToken) {
        tokens.push({ value, quoted })
        value = ''
        quoted = false
        inToken = false
      }
    } else {
      inToken = true
      if (char === '"') {
        inQuotes = true
        quoted = true
      } else {
        value += char
      }
    }
  }
  if (inToken) {
    tokens.push({ value, quoted })
  }
  return tokens
}

/** Argv for an Exec value: URL field codes become the URL, other field codes are dropped. */
export function expandDesktopEntryExec(exec: string, url: string): string[] {
  const argv: string[] = []
  let placedUrl = false
  for (const token of tokenizeDesktopExec(unescapeDesktopString(exec))) {
    if (!token.quoted && /^%[a-zA-Z]$/.test(token.value)) {
      if (URL_FIELD_CODES.has(token.value) && !placedUrl) {
        argv.push(url)
        placedUrl = true
      }
      continue
    }
    argv.push(token.value.replaceAll('%%', '%'))
  }
  if (!placedUrl) {
    argv.push(url)
  }
  return argv
}

/** Files are in XDG precedence order; the first file for an id shadows later ones. */
export function parseLinuxInstalledBrowsers(files: readonly DesktopEntryFile[]): DetectedBrowser[] {
  const seenIds = new Set<string>()
  const browsers: DetectedBrowser[] = []
  for (const file of files) {
    if (seenIds.has(file.id)) {
      continue
    }
    seenIds.add(file.id)
    const entry = parseDesktopEntryGroup(file.text)
    const name = entry.get('Name')
    const exec = entry.get('Exec')
    const mimeTypes = entry.get('MimeType')?.split(';') ?? []
    if (
      entry.get('Type') !== 'Application' ||
      entry.get('Hidden') === 'true' ||
      entry.get('NoDisplay') === 'true' ||
      // Detached launches have no terminal, so a text-mode browser would exit unseen.
      entry.get('Terminal') === 'true' ||
      !mimeTypes.includes(HTTPS_HANDLER_MIME_TYPE) ||
      !name ||
      !exec
    ) {
      continue
    }
    browsers.push({
      id: file.id,
      name: unescapeDesktopString(name),
      launchCommand: (url) => {
        const [program, ...args] = expandDesktopEntryExec(exec, url)
        return { program, args }
      }
    })
  }
  return browsers
}

function applicationDirectories(env: NodeJS.ProcessEnv): string[] {
  const dataHome = env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  const dataDirs = (env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean)
  return [dataHome, ...dataDirs].map((dir) => join(dir, 'applications'))
}

async function readDesktopEntryFiles(directory: string): Promise<DesktopEntryFile[]> {
  let names: string[]
  try {
    names = await readdir(directory)
  } catch {
    return []
  }
  const files = await Promise.all(
    names
      .filter((name) => name.endsWith('.desktop'))
      .sort()
      .map(async (name) => {
        try {
          return { id: name, text: await readFile(join(directory, name), 'utf8') }
        } catch {
          return null
        }
      })
  )
  return files.filter((file): file is DesktopEntryFile => file !== null)
}

export async function readLinuxInstalledBrowsers(): Promise<DetectedBrowser[]> {
  const filesByDirectory = await Promise.all(
    applicationDirectories(process.env).map(readDesktopEntryFiles)
  )
  return parseLinuxInstalledBrowsers(filesByDirectory.flat())
}
