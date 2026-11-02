import { platform } from 'node:os'
import path from 'node:path'
import { readdir, stat } from 'node:fs/promises'
import { readConfigFile } from '../terminal-config-import/config-file-reader'

// Includes can fan out through globs; bound how much one import may read.
const MAX_INCLUDED_FILES = 64
const AUTO_THEME_FILES = [
  'dark-theme.auto.conf',
  'light-theme.auto.conf',
  'no-preference-theme.auto.conf'
]
const KEY_RE = /^([a-zA-Z][a-zA-Z0-9_-]*)\s+(.+)$/

/** Settings keyed by Kitty option name; later lines win, as in Kitty. */
export type KittyConfig = {
  options: Map<string, string>
  unsupportedKeys: string[]
}

export type LoadedKittyConfig = {
  config: KittyConfig
  readPaths: string[]
  firstError: string | null
}

// Kitty joins a line that starts with `\` onto the previous line; `#` only starts whole-line comments.
export function parseKittyLines(content: string): [key: string, value: string][] {
  const lines: string[] = []
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trimStart()
    if (line.startsWith('\\') && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1)
    } else {
      lines.push(line)
    }
  }
  const entries: [string, string][] = []
  for (const line of lines) {
    const match = KEY_RE.exec(line.trim())
    if (!line.startsWith('#') && match) {
      entries.push([match[1], match[2].trim()])
    }
  }
  return entries
}

function expandIncludePath(value: string, baseDir: string, home: string): string {
  const kittyOs = platform() === 'darwin' ? 'macos' : platform()
  const expanded = value
    .replace(/^~(?=$|\/)/, home)
    .replace(
      /\$\{(\w+)\}|\$(\w+)/g,
      (whole, braced: string | undefined, bare: string | undefined) => {
        const name = braced ?? bare ?? ''
        return name === 'KITTY_OS' ? kittyOs : (process.env[name] ?? whole)
      }
    )
  return path.isAbsolute(expanded) ? expanded : path.join(baseDir, expanded)
}

// Kitty globs with pathlib; Orca supports wildcards in the file name, the common `themes/*.conf` form.
async function expandGlobInclude(pattern: string): Promise<string[] | null> {
  const dir = path.dirname(pattern)
  if (/[*?[]/.test(dir)) {
    return null
  }
  const source = path
    .basename(pattern)
    .replace(/[.+^${}()|\\]/g, '\\$&')
    .replaceAll('*', '.*')
    .replaceAll('?', '.')
  const nameRe = new RegExp(`^${source}$`)
  try {
    const names = await readdir(dir)
    return names
      .filter((name) => nameRe.test(name))
      .sort()
      .map((name) => path.join(dir, name))
  } catch {
    return []
  }
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile()
  } catch {
    return false
  }
}

export async function loadKittyConfig(entryPath: string, home: string): Promise<LoadedKittyConfig> {
  const options = new Map<string, string>()
  const unsupportedKeys = new Set<string>()
  const readPaths: string[] = []
  const seen = new Set<string>()
  let firstError: string | null = null

  async function loadFile(filePath: string): Promise<void> {
    const key = path.normalize(filePath)
    if (seen.has(key)) {
      return
    }
    if (seen.size >= MAX_INCLUDED_FILES) {
      unsupportedKeys.add(`include (more than ${MAX_INCLUDED_FILES} files)`)
      return
    }
    seen.add(key)
    const read = await readConfigFile(filePath)
    if (!read.ok) {
      firstError ??= read.error
      if (readPaths.length > 0) {
        unsupportedKeys.add(`include (${path.basename(filePath)}: ${read.error})`)
      }
      return
    }
    readPaths.push(filePath)
    const baseDir = path.dirname(filePath)
    for (const [optionKey, value] of parseKittyLines(read.content)) {
      if (optionKey === 'include') {
        await loadFile(expandIncludePath(value, baseDir, home))
      } else if (optionKey === 'globinclude') {
        const matches = await expandGlobInclude(expandIncludePath(value, baseDir, home))
        if (matches === null) {
          unsupportedKeys.add('globinclude (wildcards in directory names)')
        }
        for (const match of matches ?? []) {
          await loadFile(match)
        }
      } else if (optionKey === 'geninclude' || optionKey === 'envinclude') {
        // geninclude runs a program and envinclude reads the environment; an import must do neither.
        unsupportedKeys.add(optionKey)
      } else {
        options.delete(optionKey)
        options.set(optionKey, value)
      }
    }
  }

  await loadFile(entryPath)
  // Kitty 0.38+ swaps these in by OS appearance, overriding the colors above; Orca does not import them yet.
  for (const name of AUTO_THEME_FILES) {
    if (await isFile(path.join(path.dirname(entryPath), name))) {
      unsupportedKeys.add(`${name} (appearance-based theme)`)
    }
  }
  return { config: { options, unsupportedKeys: [...unsupportedKeys] }, readPaths, firstError }
}
