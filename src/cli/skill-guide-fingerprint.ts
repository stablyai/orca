import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export function skillGuideContentSha256(markdown: string): string {
  return createHash('sha256').update(markdown, 'utf8').digest('hex')
}

/**
 * CLI build identity for skill guide captures (#13210 drift audits).
 * Packaged launchers do not set ORCA_APP_VERSION; fall back to out/package.json
 * (written by verify-cli-bin with the app version) then the repo package.json.
 */
export function skillGuideCliVersion(): string {
  const env = process.env.ORCA_APP_VERSION?.trim() || process.env.npm_package_version?.trim() || ''
  if (env) {
    return env
  }
  return readNearbyPackageVersion() ?? 'unknown'
}

function readNearbyPackageVersion(): string | undefined {
  let dir = typeof __dirname === 'string' ? __dirname : process.cwd()
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, 'package.json')
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as {
          name?: string
          version?: string
        }
        const version = typeof pkg.version === 'string' ? pkg.version.trim() : ''
        if (version && (pkg.name === 'orca' || pkg.name === 'orca-compiled-output' || !pkg.name)) {
          return version
        }
      } catch {
        // keep walking
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) {
      break
    }
    dir = parent
  }
  return undefined
}
