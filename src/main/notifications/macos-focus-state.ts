import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Why: macOS has no public API for Focus state; the Focus daemon writes live assertions here.
export function defaultMacosFocusAssertionsPath(): string {
  return join(homedir(), 'Library', 'DoNotDisturb', 'DB', 'Assertions.json')
}

/** True when a Focus/Do Not Disturb assertion is live. Fails open so an unreadable store never mutes sounds. */
export async function isMacosFocusActive(
  assertionsPath: string = defaultMacosFocusAssertionsPath(),
  platform: NodeJS.Platform = process.platform
): Promise<boolean> {
  if (platform !== 'darwin') {
    return false
  }
  try {
    const root: unknown = JSON.parse(await readFile(assertionsPath, 'utf8'))
    const entries = readField(root, 'data')
    if (!Array.isArray(entries)) {
      return false
    }
    return entries.some((entry) => {
      const records = readField(entry, 'storeAssertionRecords')
      return Array.isArray(records) && records.length > 0
    })
  } catch {
    return false
  }
}

function readField(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && key in value
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined
}
