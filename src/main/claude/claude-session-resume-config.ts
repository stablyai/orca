import { lstat, realpath } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../shared/agent-session-resume'
import type { ClaudeResumeConfig } from '../../shared/claude-resume-config'
import {
  isWindowsAbsolutePathLike,
  normalizeRuntimePathForComparison,
  relativePathInsideRoot
} from '../../shared/cross-platform-path'

export type ClaudeSessionResumePreparation =
  | {
      outcome: 'resume'
      configDir: string | null
      userHome: string
      source: 'managed' | 'recipe' | 'capture'
    }
  | {
      outcome: 'unavailable'
      reason: 'unknown-store' | 'missing-transcript' | 'store-mismatch' | 'invalid-path'
    }

export type ClaudeResumeAccountHome = { configDir: string; readPath: string }

function isAbsoluteStorePath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 4096 &&
    !Array.from(value).some((char) => char.charCodeAt(0) <= 0x1f || char.charCodeAt(0) === 0x7f) &&
    !value.startsWith('\\\\?\\') &&
    !value.startsWith('\\\\.\\') &&
    !value.split(/[\\/]/).some((part) => part === '..' || part === '.') &&
    (isWindowsAbsolutePathLike(value) ? win32.isAbsolute(value) : posix.isAbsolute(value))
  )
}

/** #26510's projects layout identifies a candidate, never authority to select its credentials. */
export function claudeConfigDirFromTranscriptPath(transcriptPath: string): string | null {
  if (!isAbsoluteStorePath(transcriptPath)) {
    return null
  }
  const path = isWindowsAbsolutePathLike(transcriptPath) ? win32 : posix
  const file = path.basename(transcriptPath)
  const project = path.dirname(transcriptPath)
  const projects = path.dirname(project)
  return path.basename(projects) === 'projects' && file.endsWith('.jsonl')
    ? path.dirname(projects)
    : null
}

async function hasRegularTranscript(
  home: string,
  transcript: string,
  sharedHistoryHomes: readonly string[]
): Promise<boolean> {
  try {
    if (!(await lstat(transcript)).isFile() || !(await lstat(home)).isDirectory()) {
      return false
    }
    const path = isWindowsAbsolutePathLike(home) ? win32 : posix
    const projects = await realpath(path.join(home, 'projects'))
    const ownProjects = path.join(await realpath(home), 'projects')
    if (
      normalizeRuntimePathForComparison(projects) !== normalizeRuntimePathForComparison(ownProjects)
    ) {
      const allowed = await Promise.all(
        sharedHistoryHomes.map(async (root) => {
          try {
            return await realpath(path.join(root, 'projects'))
          } catch {
            return null
          }
        })
      )
      if (
        !allowed.some(
          (root) =>
            root &&
            normalizeRuntimePathForComparison(root) === normalizeRuntimePathForComparison(projects)
        )
      ) {
        return false
      }
    }
    if (!(await lstat(path.dirname(transcript))).isDirectory()) {
      return false
    }
    const relative = relativePathInsideRoot(projects, await realpath(transcript))
    return Boolean(relative && /^[^/]+\/[^/]+\.jsonl$/.test(relative.replace(/\\/g, '/')))
  } catch {
    return false
  }
}

async function hasUnlinkedManagedHome(root: string, home: string): Promise<boolean> {
  const suffix = relativePathInsideRoot(root, home)
  if (!suffix) {
    return false
  }
  const path = isWindowsAbsolutePathLike(root) ? win32 : posix
  let cursor = root
  try {
    if (!(await lstat(cursor)).isDirectory()) {
      return false
    }
    for (const part of suffix.split(/[\\/]/)) {
      cursor = path.join(cursor, part)
      if (!(await lstat(cursor)).isDirectory()) {
        return false
      }
    }
    return true
  } catch {
    return false
  }
}

export async function prepareClaudeSessionResumeConfig(args: {
  providerSession: AgentProviderSessionMetadata
  launchConfig?: SleepingAgentLaunchConfig
  accountHomes: readonly ClaudeResumeAccountHome[]
  userHome: string
  managedProfileRoot?: string
  sharedHistoryHomes?: readonly string[]
  /** Supplied only after the execution host has admitted the captured origin. */
  admittedConfig?: ClaudeResumeConfig
  toReadPath?: (path: string) => string
}): Promise<ClaudeSessionResumePreparation> {
  const transcript = args.providerSession.transcriptPath
  if (!transcript) {
    return { outcome: 'unavailable', reason: 'missing-transcript' }
  }
  const candidate = claudeConfigDirFromTranscriptPath(transcript)
  if (!candidate) {
    return { outcome: 'unavailable', reason: 'invalid-path' }
  }
  const captured = args.admittedConfig
  const saved = args.launchConfig?.agentEnv.CLAUDE_CONFIG_DIR
  const account = args.accountHomes.find(
    (home) =>
      normalizeRuntimePathForComparison(home.configDir) ===
      normalizeRuntimePathForComparison(candidate)
  )
  if (
    args.managedProfileRoot &&
    relativePathInsideRoot(args.managedProfileRoot, candidate) &&
    !account
  ) {
    return { outcome: 'unavailable', reason: 'unknown-store' }
  }
  if (
    account &&
    args.managedProfileRoot &&
    !(await hasUnlinkedManagedHome(
      args.toReadPath?.(args.managedProfileRoot) ?? args.managedProfileRoot,
      account.readPath
    ))
  ) {
    return { outcome: 'unavailable', reason: 'missing-transcript' }
  }
  let configDir: string | null
  let source: 'managed' | 'recipe' | 'capture'
  let readPath: string
  if (captured) {
    if (
      normalizeRuntimePathForComparison(captured.userHome) !==
      normalizeRuntimePathForComparison(args.userHome)
    ) {
      return { outcome: 'unavailable', reason: 'store-mismatch' }
    }
    const path = isWindowsAbsolutePathLike(args.userHome) ? win32 : posix
    configDir = captured.kind === 'explicit' ? captured.value : null
    const expected = configDir ?? path.join(args.userHome, '.claude')
    if (
      !isAbsoluteStorePath(expected) ||
      normalizeRuntimePathForComparison(expected) !== normalizeRuntimePathForComparison(candidate)
    ) {
      return { outcome: 'unavailable', reason: 'store-mismatch' }
    }
    source = 'capture'
    readPath = args.toReadPath?.(expected) ?? expected
  } else if (saved) {
    if (
      !isAbsoluteStorePath(saved) ||
      normalizeRuntimePathForComparison(saved) !== normalizeRuntimePathForComparison(candidate)
    ) {
      return { outcome: 'unavailable', reason: 'store-mismatch' }
    }
    if (!account) {
      return { outcome: 'unavailable', reason: 'unknown-store' }
    }
    configDir = saved
    source = 'recipe'
    readPath = args.toReadPath?.(saved) ?? saved
  } else {
    if (!account) {
      return { outcome: 'unavailable', reason: 'unknown-store' }
    }
    configDir = account.configDir
    source = 'managed'
    readPath = account.readPath
  }
  return (await hasRegularTranscript(
    readPath,
    args.toReadPath?.(transcript) ?? transcript,
    account ? (args.sharedHistoryHomes ?? []) : []
  ))
    ? { outcome: 'resume', configDir, userHome: args.userHome, source }
    : { outcome: 'unavailable', reason: 'missing-transcript' }
}
