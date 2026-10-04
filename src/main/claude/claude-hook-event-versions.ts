import { hasReachedAppVersion, isValidAppVersion } from '../../shared/app-version'
import { runProcess } from '../../shared/child-process/run-process'
import path from 'node:path'

// Why: Claude 1.0.23 through 2.1.100 validate `hooks` against a closed event enum and discard the
// WHOLE settings.json (env, permissions, every user hook) on one unknown name, so an event may only
// be written for a Claude that knows it. Values come from each release's packed enum, pinned by
// __fixtures__/claude-hook-event-enums.json.
export const CLAUDE_HOOK_EVENT_FIRST_VERSIONS = {
  PreToolUse: '1.0.23',
  PostToolUse: '1.0.23',
  Stop: '1.0.31',
  SubagentStop: '1.0.41',
  UserPromptSubmit: '1.0.53',
  SessionStart: '1.0.62',
  SessionEnd: '1.0.85',
  SubagentStart: '2.0.43',
  PermissionRequest: '2.0.45',
  PostToolUseFailure: '2.0.56',
  TeammateIdle: '2.1.33',
  PostCompact: '2.1.76',
  StopFailure: '2.1.78'
} as const

// Why: 1.0.49 through 1.0.66 also discard the whole file over an unknown top-level key, and
// `statusLine` joined their schema only in 1.0.64. Pinned by the same fixture's topLevelSettings.
export const CLAUDE_STATUS_LINE_FIRST_VERSION = '1.0.64'

// Why: an unresolved version gets what the first release accepting Orca's core lifecycle events and
// statusLine knows, and nothing newer; a Claude older than that is gated only once its version resolves.
export const UNRESOLVED_CLAUDE_VERSION = CLAUDE_STATUS_LINE_FIRST_VERSION

export type ClaudeHookEventName = keyof typeof CLAUDE_HOOK_EVENT_FIRST_VERSIONS

export function parseClaudeCliVersion(output: string | null | undefined): string | null {
  const version = output?.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\b/)?.[0]
  return version && isValidAppVersion(version) ? version : null
}

export function claudeVersionReaches(version: string | null | undefined, floor: string): boolean {
  const parsed = parseClaudeCliVersion(version)
  return parsed !== null && hasReachedAppVersion(parsed, floor)
}

function claudeKnowsSince(version: string | null | undefined, firstVersion: string): boolean {
  return hasReachedAppVersion(
    parseClaudeCliVersion(version) ?? UNRESOLVED_CLAUDE_VERSION,
    firstVersion
  )
}

export function claudeKnowsHookEvent(
  version: string | null | undefined,
  eventName: ClaudeHookEventName
): boolean {
  return claudeKnowsSince(version, CLAUDE_HOOK_EVENT_FIRST_VERSIONS[eventName])
}

export function claudeKnowsStatusLine(version: string | null | undefined): boolean {
  return claudeKnowsSince(version, CLAUDE_STATUS_LINE_FIRST_VERSION)
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
