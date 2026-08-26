import { readFileSync } from 'node:fs'
import { join } from 'node:path'

type VersionPackage = { version?: unknown }

export function resolveCliAppVersion(moduleDirectory = __dirname): string {
  for (const packagePath of [
    join(moduleDirectory, '..', 'package.json'),
    join(moduleDirectory, '..', '..', 'package.json')
  ]) {
    try {
      const version = (JSON.parse(readFileSync(packagePath, 'utf8')) as VersionPackage).version
      if (typeof version === 'string' && version.length > 0) {
        return version
      }
    } catch {
      // Try the source-tree fallback after the packaged output boundary.
    }
  }

  throw new Error('Unable to determine the Orca application version.')
}
