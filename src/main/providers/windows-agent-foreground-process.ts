import {
  isAgentForegroundWrapperProcess,
  isExpectedAgentProcess,
  recognizeAgentProcess,
  recognizeAgentProcessFromCommandLine,
  type RecognizedAgentProcess
} from '../../shared/agent-process-recognition'
import {
  resolveOuterWrapperForegroundIdentity,
  shouldInspectOuterWrapperForegroundProcess
} from '../../shared/foreground-wrapper-agent'
import { isShellProcess } from '../../shared/shell-process-detection'
import {
  queryWindowsPaneProcessInventory,
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
  readWindowsConsoleAttachedProcessIds?: () => Promise<ReadonlySet<number> | null>
  /**
   * A caller's cached liveness anchor. When a scan row holds this pid but no
   * longer recognizes as the cached agent, the pid was recycled by a different
   * process (command lines are immutable): the resolution reports it foreign.
   */
  anchorProcessId?: number
  /** The cached agent name the anchor pid is supposed to prove. */
  anchorProcessName?: string
}

export type WindowsAgentForegroundResolution = {
  available: boolean
  processName: string | null
  /**
   * Pid of the process the name belongs to — the liveness anchor a caller may
   * check against the pane's job. The OUTER wrapper's pid when the name
   * collapsed onto one (its embedded leaf may exit first). Absent when the
   * name came from a fallback or when sibling leaves left no single anchor.
   */
  processId?: number
  /** True when the scan proves `anchorProcessId` now belongs to a non-agent. */
  anchorPidForeign?: boolean
}

type WindowsForegroundIdentity = {
  processName: string | null
  processId?: number
}

export function shouldInspectWindowsAgentForeground(fallbackProcess: string): boolean {
  const recognized = recognizeAgentProcess(fallbackProcess)
  return (
    isAgentForegroundWrapperProcess(fallbackProcess) ||
    isShellProcess(fallbackProcess) ||
    (recognized !== null && shouldInspectOuterWrapperForegroundProcess(recognized))
  )
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
  const inventory = await queryWindowsPaneProcessInventory(shellPid, {
    ...(options.fresh === true ? { fresh: true } : {}),
    ...(options.anchorProcessId !== undefined ? { anchorPid: options.anchorProcessId } : {})
  })
  if (!inventory) {
    return { available: false, processName: null }
  }
  const candidates = inventory.candidates
  // Resolve membership before applying the global ambiguity rule. A detached
  // agent can otherwise make an attached Droid look ambiguous and suppress
  // the only identity that is actually able to receive this PTY's input.
  const hasRecognizedCandidate = windowsCandidatesContainRecognizedAgent(
    candidates,
    fallbackProcess,
    options.contextPaths
  )
  let filteredCandidates = candidates
  if (hasRecognizedCandidate && options.readWindowsConsoleAttachedProcessIds) {
    // Why console attachment and not the job: this filter exists to DROP a
    // descendant that detached from the console, and the job still contains
    // those by design. Answering it from the job would re-admit precisely what
    // the filter is for -- granting byte authority to a detached `Start-Process
    // droid`, or making an attached agent look ambiguous.
    const consoleProcessIds = await options.readWindowsConsoleAttachedProcessIds()
    if (!consoleProcessIds) {
      return { available: false, processName: null }
    }
    filteredCandidates = candidates.filter((candidate) => consoleProcessIds.has(candidate.pid))
  }
  // From the FULL table, not the ppid projection: an orphaned job member (its
  // creator exited) leaves the descendant walk yet can hold a recycled pid.
  const anchorRow = inventory.anchorRow
  const anchorRecognized = anchorRow === null ? null : recognizeWindowsProcessCandidate(anchorRow)
  const anchorPidForeign =
    anchorRow !== null &&
    (anchorRecognized !== null
      ? // A recognized row is foreign when it names a DIFFERENT agent.
        options.anchorProcessName !== undefined &&
        anchorRecognized.processName !== options.anchorProcessName
      : // A query-denied row falls back to command === name; that is
        // inconclusive (the agent may just be unreadable), never foreign.
        anchorRow.command !== anchorRow.name)
  return {
    available: true,
    ...resolveWindowsForegroundIdentity(filteredCandidates, fallbackProcess, options.contextPaths),
    ...(anchorPidForeign ? { anchorPidForeign: true } : {})
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

function resolveWindowsForegroundIdentity(
  candidates: readonly WindowsProcessCandidate[],
  fallbackProcess: string,
  contextPaths: readonly string[] | undefined
): WindowsForegroundIdentity {
  if (isShellProcess(fallbackProcess)) {
    return resolveShellForegroundProcessFromWindowsCandidates(candidates, contextPaths)
  }
  const wrapperCandidates = candidates.filter((candidate) =>
    windowsCandidateMatchesFallbackWrapper(candidate, fallbackProcess)
  )
  if (wrapperCandidates.length !== 1) {
    return resolveWrapperForegroundProcessFromWindowsCandidates(
      wrapperCandidates,
      candidates,
      contextPaths
    )
  }
  const [candidate] = wrapperCandidates
  const recognized =
    recognizeAgentProcessFromCommandLine(candidate.command) ??
    recognizeAgentProcessFromCommandLine(candidate.name)
  if (recognized) {
    return resolveOuterWrapperForegroundIdentity(recognized, candidate, candidates)
  }
  return { processName: null }
}

function resolveShellForegroundProcessFromWindowsCandidates(
  candidates: readonly WindowsProcessCandidate[],
  contextPaths: readonly string[] | undefined
): WindowsForegroundIdentity {
  const recognizedCandidates = createRecognizedWindowsProcessCandidates(candidates, contextPaths)
  const contextCandidates = recognizedCandidates.filter((candidate) => candidate.contextMatch)
  if (contextCandidates.length > 0) {
    return resolveRecognizedWindowsProcessCandidates(contextCandidates, candidates)
  }
  return resolveRecognizedWindowsProcessCandidates(recognizedCandidates, candidates)
}

function resolveWrapperForegroundProcessFromWindowsCandidates(
  candidates: readonly WindowsProcessCandidate[],
  allCandidates: readonly WindowsProcessCandidate[],
  contextPaths: readonly string[] | undefined
): WindowsForegroundIdentity {
  const contextCandidates = createRecognizedWindowsProcessCandidates(
    candidates,
    contextPaths
  ).filter((candidate) => candidate.contextMatch)
  return contextCandidates.length > 0
    ? resolveRecognizedWindowsProcessCandidates(contextCandidates, allCandidates)
    : { processName: null }
}

type RecognizedWindowsProcessCandidate = WindowsProcessRow & {
  contextMatch: boolean
  depth: number
  processName: string
  recognized: RecognizedAgentProcess
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
        processName: recognized.processName,
        recognized
      }
    ]
  })
}

function resolveRecognizedWindowsProcessCandidates(
  recognizedCandidates: readonly RecognizedWindowsProcessCandidate[],
  allCandidates: readonly WindowsProcessCandidate[]
): WindowsForegroundIdentity {
  if (recognizedCandidates.length === 0) {
    return { processName: null }
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
  const leafIdentities = leafCandidates.map((candidate) =>
    resolveOuterWrapperForegroundIdentity(candidate.recognized, candidate, allCandidates)
  )
  const leafProcessNames = new Set(leafIdentities.map((identity) => identity.processName))
  // Why: Windows lacks a cheap PTY foreground marker like POSIX '+'. A single
  // recognized lineage leaf is strong enough; sibling agent leaves are not.
  if (leafProcessNames.size !== 1) {
    return { processName: null }
  }
  // The anchor is the process the NAME belongs to — the outer wrapper when the
  // leaf collapsed onto one, else the leaf itself. An embedded leaf can exit
  // and restart under a live wrapper; its pid must not stand for the wrapper's.
  const anchorProcessIds = new Set(leafIdentities.map((identity) => identity.processId))
  return {
    processName: [...leafProcessNames][0],
    // Distinct anchors agreeing on one name still leave no single liveness anchor.
    ...(anchorProcessIds.size === 1 ? { processId: [...anchorProcessIds][0] } : {})
  }
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
  const haystack = normalizePathForCommandMatch(candidate.command)
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

function recognizeWindowsProcessCandidate(
  candidate: WindowsProcessRow
): RecognizedAgentProcess | null {
  return (
    recognizeAgentProcessFromCommandLine(candidate.command) ??
    recognizeAgentProcessFromCommandLine(candidate.name)
  )
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
