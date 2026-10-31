import { hasReachedAppVersion, isValidAppVersion } from '../../shared/app-version'
import { runProcess } from '@orca/process-host'
import path from 'node:path'

// Unknown hook events make older CLIs reject all settings, including user hooks.
// Floors come from packed enums in __fixtures__/claude-hook-event-enums.json.
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
  Elicitation: '2.1.63',
  ElicitationResult: '2.1.63',
  PostCompact: '2.1.76',
  StopFailure: '2.1.78'
} as const

// Older CLIs reject the whole settings file on an unknown top-level key.
export const CLAUDE_STATUS_LINE_FIRST_VERSION = '1.0.64'

// Exec-form hooks (`args`) spawn without a shell, so a spaced path needs no quoting.
const CLAUDE_HOOK_EXEC_FORM_FIRST_VERSION = '2.1.139'

// Unknown versions get the core lifecycle/statusLine floor until a probe resolves their actual version.
export const UNRESOLVED_CLAUDE_VERSION = CLAUDE_STATUS_LINE_FIRST_VERSION

export type ClaudeHookEventName = keyof typeof CLAUDE_HOOK_EVENT_FIRST_VERSIONS

export function parseClaudeCliVersion(output: string | null | undefined): string | null {
  const version = output?.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\b/)?.[0]
  return version && isValidAppVersion(version) ? version : null
}

// A launcher in Command (`npx claude`, `op run -- claude`) answers `--version` with its own
// version; only Claude's own `x.y.z (Claude Code)` line may pick the hook events.
export function parseClaudeCliVersionOutput(output: string | null | undefined): string | null {
  const version = output?.match(
    /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)[ \t]+\(Claude Code\)/i
  )?.[1]
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

// Unknown versions keep the shell form because an older CLI ignores `args`.
export function claudeAcceptsExecFormHooks(version: string | null | undefined): boolean {
  return claudeVersionReaches(version, CLAUDE_HOOK_EXEC_FORM_FIRST_VERSION)
}

/** Probe with the launch cwd and env so version-manager shims select the same CLI. */
export async function probeClaudeCliVersion(
  executablePath: string,
  launch?: {
    cwd: string
    env: Record<string, string>
    timeoutMs?: number
    prefixArgs?: readonly string[]
  }
): Promise<string | null> {
  try {
    const pathKey = process.platform === 'win32' && process.env.Path !== undefined ? 'Path' : 'PATH'
    const executableDir = path.dirname(executablePath)
    const inheritedPath = process.env[pathKey]
    const result = await runProcess({
      program: executablePath,
      args: [...(launch?.prefixArgs ?? []), '--version'],
      terminationBarrier: true,
      // Keep the sibling runtime on PATH for version-manager shims using /usr/bin/env node.
      env: launch?.env ?? {
        ...process.env,
        [pathKey]: inheritedPath
          ? `${executableDir}${path.delimiter}${inheritedPath}`
          : executableDir
      },
      ...(launch ? { cwd: launch.cwd } : {}),
      timeoutMs: launch?.timeoutMs ?? 5_000,
      maxOutputBytes: 4_096
    })
    return result.code === 0
      ? parseClaudeCliVersionOutput(`${result.stdout}\n${result.stderr}`)
      : null
  } catch {
    return null
  }
}

const RECENT_VERSION_MS = 5 * 60_000
const recentVersions = new Map<string, { at: number; value: Promise<string | null> }>()

/** Account folders refresh on each launch; hook plans need only a recent version. */
export function probeRecentClaudeCliVersion(executablePath: string): Promise<string | null> {
  const recent = recentVersions.get(executablePath)
  if (recent && Date.now() - recent.at <= RECENT_VERSION_MS) {
    return recent.value
  }
  const value = probeClaudeCliVersion(executablePath)
  recentVersions.set(executablePath, { at: Date.now(), value })
  return value
}
