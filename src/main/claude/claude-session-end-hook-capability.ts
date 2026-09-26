import { hasReachedAppVersion, isValidAppVersion } from '../../shared/app-version'
import { runProcess } from '../../shared/child-process/run-process'
import path from 'node:path'

// 2.1.261 is the only version measured, not an established minimum.
export const CLAUDE_SESSION_END_CAPABILITY_FLOOR = '2.1.261'

export function parseClaudeCliVersion(output: string | null | undefined): string | null {
  const version = output?.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\b/)?.[0]
  return version && isValidAppVersion(version) ? version : null
}

export function claudeVersionSupportsSessionEnd(version: string | null | undefined): boolean {
  const parsed = parseClaudeCliVersion(version)
  return parsed !== null && hasReachedAppVersion(parsed, CLAUDE_SESSION_END_CAPABILITY_FLOOR)
}

export async function probeClaudeCliVersion(executablePath: string): Promise<string | null> {
  try {
    const pathKey = process.platform === 'win32' && process.env.Path !== undefined ? 'Path' : 'PATH'
    const executableDir = path.dirname(executablePath)
    const inheritedPath = process.env[pathKey]
    const result = await runProcess({
      program: executablePath,
      args: ['--version'],
      // Why: version-manager launchers often use `#!/usr/bin/env node`; the resolved CLI's sibling
      // runtime must remain reachable even when Electron started with a thinner PATH.
      env: {
        ...process.env,
        [pathKey]: inheritedPath
          ? `${executableDir}${path.delimiter}${inheritedPath}`
          : executableDir
      },
      timeoutMs: 5_000,
      maxOutputBytes: 4_096
    })
    return result.code === 0 ? parseClaudeCliVersion(`${result.stdout}\n${result.stderr}`) : null
  } catch {
    return null
  }
}
