import {
  isAgentForegroundWrapperProcess,
  isExpectedAgentProcess,
  recognizeAgentProcessFromCommandLine
} from '../../shared/agent-process-recognition'
import { isShellProcess } from '../../shared/shell-process-detection'
import {
  queryWindowsProcessDescendants,
  type WindowsProcessCandidate,
  type WindowsProcessRow
} from './windows-foreground-process-rows'

export type AgentForegroundResolutionOptions = {
  contextPaths?: readonly string[]
  /** Require a Windows process-table scan started after this request. */
  fresh?: boolean
  /** Force confirmation scans even when node-pty reports a recognized name. */
  forceProcessScan?: boolean
  /** Lazily proves which global descendants still belong to this ConPTY. */
  readWindowsConptyProcessIds?: () => Promise<ReadonlySet<number> | null>
}

export type WindowsAgentForegroundResolution = {
  available: boolean
  processName: string | null
}

export function shouldInspectWindowsAgentForeground(fallbackProcess: string): boolean {
  return isAgentForegroundWrapperProcess(fallbackProcess) || isShellProcess(fallbackProcess)
}

export async function resolveWindowsAgentForegroundProcess(
  shellPid: number,
  fallbackProcess: string,
  options: AgentForegroundResolutionOptions
): Promise<string | null> {
  return (
    await resolveWindowsAgentForegroundProcessWithAvailability(shellPid, fallbackProcess, options)
  ).processName
}

export async function resolveWindowsAgentForegroundProcessWithAvailability(
  shellPid: number,
  fallbackProcess: string,
  options: AgentForegroundResolutionOptions
): Promise<WindowsAgentForegroundResolution> {
  const candidates = await queryWindowsProcessDescendants(
    shellPid,
    options.fresh === true ? { fresh: true } : {}
  )
  if (!candidates) {
    return { available: false, processName: null }
  }
  // Resolve membership before applying the global ambiguity rule. A detached
  // agent can otherwise make an attached Droid look ambiguous and suppress
  // the only identity that is actually able to receive this PTY's input.
  const hasRecognizedCandidate = windowsCandidatesContainRecognizedAgent(
    candidates,
    fallbackProcess,
    options.contextPaths
  )
  let filteredCandidates = candidates
  if (hasRecognizedCandidate && options.readWindowsConptyProcessIds) {
    const conptyProcessIds = await options.readWindowsConptyProcessIds()
    if (!conptyProcessIds) {
      return { available: false, processName: null }
    }
    filteredCandidates = candidates.filter((candidate) => conptyProcessIds.has(candidate.pid))
  }
  return {
    available: true,
    processName: resolveWindowsProcessName(
      filteredCandidates,
      fallbackProcess,
      options.contextPaths
    )
  }
}

function windowsCandidatesContainRecognizedAgent(
  candidates: readonly WindowsProcessCandidate[],
  fallbackProcess: string,
  contextPaths: readonly string[] | undefined
): boolean {
  if (isShellProcess(fallbackProcess)) {
    return createRecognizedWindowsProcessCandidates(candidates, contextPaths).length > 0
  }
  return candidates
    .filter((candidate) => windowsCandidateMatchesFallbackWrapper(candidate, fallbackProcess))
    .some(
      (candidate) =>
        recognizeAgentProcessFromCommandLine(candidate.command) !== null ||
        recognizeAgentProcessFromCommandLine(candidate.name) !== null
    )
}

function resolveWindowsProcessName(
  candidates: readonly WindowsProcessCandidate[],
  fallbackProcess: string,
  contextPaths: readonly string[] | undefined
): string | null {
  if (isShellProcess(fallbackProcess)) {
    return resolveShellForegroundProcessFromWindowsCandidates(candidates, contextPaths)
  }
  const wrapperCandidates = candidates.filter((candidate) =>
    windowsCandidateMatchesFallbackWrapper(candidate, fallbackProcess)
  )
  if (wrapperCandidates.length !== 1) {
    return resolveWrapperForegroundProcessFromWindowsCandidates(wrapperCandidates, contextPaths)
  }
  const [candidate] = wrapperCandidates
  const recognized =
    recognizeAgentProcessFromCommandLine(candidate.command) ??
    recognizeAgentProcessFromCommandLine(candidate.name)
  if (recognized) {
    return recognized.processName
  }
  return null
}

function resolveShellForegroundProcessFromWindowsCandidates(
  candidates: readonly WindowsProcessCandidate[],
  contextPaths: readonly string[] | undefined
): string | null {
  const recognizedCandidates = createRecognizedWindowsProcessCandidates(candidates, contextPaths)
  const contextCandidates = recognizedCandidates.filter((candidate) => candidate.contextMatch)
  if (contextCandidates.length > 0) {
    return resolveRecognizedWindowsProcessCandidates(contextCandidates, candidates)
  }
  return resolveRecognizedWindowsProcessCandidates(recognizedCandidates, candidates)
}

function resolveWrapperForegroundProcessFromWindowsCandidates(
  candidates: readonly WindowsProcessCandidate[],
  contextPaths: readonly string[] | undefined
): string | null {
  const contextCandidates = createRecognizedWindowsProcessCandidates(
    candidates,
    contextPaths
  ).filter((candidate) => candidate.contextMatch)
  return contextCandidates.length > 0
    ? resolveRecognizedWindowsProcessCandidates(contextCandidates, candidates)
    : null
}

type RecognizedWindowsProcessCandidate = WindowsProcessRow & {
  contextMatch: boolean
  depth: number
  processName: string
}

function createRecognizedWindowsProcessCandidates(
  candidates: readonly WindowsProcessCandidate[],
  contextPaths: readonly string[] | undefined
): RecognizedWindowsProcessCandidate[] {
  const normalizedContextPaths = normalizeContextPaths(contextPaths)
  return candidates.flatMap((candidate) => {
    const recognized = recognizeWindowsProcessCandidate(candidate)
    if (!recognized) {
      return []
    }
    return [
      {
        ...candidate,
        contextMatch: candidateMatchesContextPath(candidate, normalizedContextPaths),
        processName: recognized
      }
    ]
  })
}

function resolveRecognizedWindowsProcessCandidates(
  recognizedCandidates: readonly RecognizedWindowsProcessCandidate[],
  allCandidates: readonly WindowsProcessCandidate[]
): string | null {
  if (recognizedCandidates.length === 0) {
    return null
  }
  const recognizedProcessNames = new Set(
    recognizedCandidates.map((candidate) => candidate.processName)
  )
  if (recognizedProcessNames.size === 1) {
    return [...recognizedProcessNames][0]
  }

  const candidatesByPid = new Map(allCandidates.map((candidate) => [candidate.pid, candidate]))
  const leafCandidates = recognizedCandidates.filter(
    (candidate) =>
      !recognizedCandidates.some(
        (other) =>
          other.pid !== candidate.pid &&
          windowsCandidateIsAncestor(candidate, other, candidatesByPid)
      )
  )
  const leafProcessNames = new Set(leafCandidates.map((candidate) => candidate.processName))
  // Why: Windows lacks a cheap PTY foreground marker like POSIX '+'. A single
  // recognized lineage leaf is strong enough; sibling agent leaves are not.
  return leafProcessNames.size === 1 ? [...leafProcessNames][0] : null
}

function windowsCandidateIsAncestor(
  candidate: WindowsProcessRow,
  other: WindowsProcessRow,
  candidatesByPid: ReadonlyMap<number, WindowsProcessRow>
): boolean {
  let current = candidatesByPid.get(other.ppid)
  while (current) {
    if (current.pid === candidate.pid) {
      return true
    }
    current = candidatesByPid.get(current.ppid)
  }
  return false
}

function normalizeContextPaths(contextPaths: readonly string[] | undefined): string[] {
  const normalized = new Set<string>()
  for (const contextPath of contextPaths ?? []) {
    const candidate = normalizePathForCommandMatch(contextPath)
    if (isSafeContextPath(candidate)) {
      normalized.add(candidate)
    }
  }
  return [...normalized].sort((a, b) => b.length - a.length)
}

function isSafeContextPath(contextPath: string): boolean {
  return contextPath.length >= 4 && (/^[a-z]:\//.test(contextPath) || contextPath.startsWith('//'))
}

function candidateMatchesContextPath(
  candidate: WindowsProcessRow,
  normalizedContextPaths: readonly string[]
): boolean {
  if (normalizedContextPaths.length === 0) {
    return false
  }
  const haystack = normalizePathForCommandMatch(
    [candidate.command, candidate.executablePath].filter(Boolean).join('\n')
  )
  return normalizedContextPaths.some((contextPath) =>
    commandLineContainsPath(haystack, contextPath)
  )
}

function normalizePathForCommandMatch(value: string): string {
  return value
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\\/g, '/')
    .replace(/\/+$/g, '')
    .toLowerCase()
}

function commandLineContainsPath(haystack: string, contextPath: string): boolean {
  let index = haystack.indexOf(contextPath)
  while (index !== -1) {
    const before = index > 0 ? haystack[index - 1] : ''
    const after = haystack[index + contextPath.length] ?? ''
    const beforeOk = !before || /[\s"'(=]/.test(before)
    const afterOk = !after || after === '/' || /[\s"'),;]/.test(after)
    if (beforeOk && afterOk) {
      return true
    }
    index = haystack.indexOf(contextPath, index + 1)
  }
  return false
}

function recognizeWindowsProcessCandidate(candidate: WindowsProcessRow): string | null {
  const recognized =
    recognizeAgentProcessFromCommandLine(candidate.command) ??
    recognizeAgentProcessFromCommandLine(candidate.name)
  return recognized?.processName ?? null
}

function windowsCandidateMatchesFallbackWrapper(
  candidate: WindowsProcessRow,
  fallbackProcess: string
): boolean {
  const commandToken = candidate.command.trim().split(/\s+/, 1)[0] ?? ''
  return (
    isExpectedAgentProcess(candidate.name, fallbackProcess) ||
    isExpectedAgentProcess(commandToken, fallbackProcess)
  )
}
