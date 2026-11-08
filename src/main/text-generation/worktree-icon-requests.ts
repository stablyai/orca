import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LOCAL_COMMIT_MESSAGE_HOST_KEY } from '../../shared/source-control/ai/generation/commit-message-host-key'
import type { ResolvedSourceControlAiGenerationParams } from '../../shared/source-control/ai/source-control-ai-operation-resolution'
import {
  buildWorktreeIconPrompt,
  extractWorktreeIconSvg,
  normalizeWorktreeIconName,
  type WorktreeIconGenerationResult
} from '../../shared/worktree/worktree-icon-generation'
import { runGenerationRequest } from './agent-generation-request'
import {
  prepareLocalCommitMessageAgentEnv,
  type CommitMessageAgentEnvironmentResolvers
} from './commit-message-agent-environment'
import { resolveTextGenerationParams } from './commit-message-text-generation'
import { spawnSourceControlAgent } from './source-control-agent-launch'
import { cancelLocalGeneration } from './source-control-generation-lanes'

export type WorktreeIconGenerationHost = {
  getSettings: () => Parameters<typeof resolveTextGenerationParams>[0]
  getAgentEnvironment: () => CommitMessageAgentEnvironmentResolvers | undefined
  cacheFile: string
}

const MAX_CACHED_ICONS = 500

let cache: Map<string, string> | null = null
type IconRequest = {
  host: WorktreeIconGenerationHost
  name: string
  controller: AbortController
  consumers: number
  settled: boolean
  result: ReturnType<typeof Promise.withResolvers<WorktreeIconGenerationResult>>
}
const inFlight = new Map<string, IconRequest>()
const queued = new Set<IconRequest>()
let active: IconRequest | undefined
const canceledResult = (): WorktreeIconGenerationResult => ({
  success: false,
  canceled: true,
  error: 'Generation canceled.'
})

function loadCache(file: string): Map<string, string> {
  if (cache) {
    return cache
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    cache = new Map(
      parsed && typeof parsed === 'object'
        ? Object.entries(parsed).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string'
          )
        : []
    )
  } catch {
    cache = new Map()
  }
  return cache
}

function remember(file: string, name: string, svg: string): void {
  const icons = loadCache(file)
  icons.delete(name)
  icons.set(name, svg)
  while (icons.size > MAX_CACHED_ICONS) {
    const oldest = icons.keys().next().value
    if (oldest === undefined) {
      break
    }
    icons.delete(oldest)
  }
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(Object.fromEntries(icons)))
  } catch {
    // The in-memory copy still serves this session.
  }
}

// Icons want a fast model that draws well; the user's naming agent is the fallback.
const PREFERRED_ICON_PARAMS: ResolvedSourceControlAiGenerationParams = {
  agentId: 'codex',
  model: 'gpt-6.1-terra',
  thinkingLevel: 'low'
}

async function generateWith(
  host: WorktreeIconGenerationHost,
  params: ResolvedSourceControlAiGenerationParams,
  name: string,
  signal: AbortSignal
): Promise<WorktreeIconGenerationResult> {
  if (signal.aborted) {
    return canceledResult()
  }
  const localEnv = await prepareLocalCommitMessageAgentEnv(
    params.agentId,
    host.getAgentEnvironment()
  )
  if (signal.aborted) {
    return canceledResult()
  }
  if (!localEnv.ok) {
    return { success: false, error: localEnv.error }
  }
  const result = await runGenerationRequest({
    params,
    prompt: buildWorktreeIconPrompt(name),
    target: { kind: 'local', cwd: os.homedir(), ...(localEnv.env ? { env: localEnv.env } : {}) },
    spawnAgent: spawnSourceControlAgent,
    operation: 'worktree-icon',
    shouldExecute: () => !signal.aborted
  })
  if (!result.success) {
    return { success: false, error: result.error, canceled: result.canceled }
  }
  const svg = extractWorktreeIconSvg(result.rawOutput)
  return svg
    ? { success: true, svg }
    : { success: false, error: `${result.agentLabel ?? 'The agent'} did not return an SVG icon.` }
}

async function generate(
  host: WorktreeIconGenerationHost,
  name: string,
  signal: AbortSignal
): Promise<WorktreeIconGenerationResult> {
  const preferred = await generateWith(host, PREFERRED_ICON_PARAMS, name, signal)
  if (signal.aborted) {
    return canceledResult()
  }
  let result = preferred
  if (!preferred.success && !preferred.canceled) {
    const configured = resolveTextGenerationParams(
      host.getSettings(),
      LOCAL_COMMIT_MESSAGE_HOST_KEY,
      'branchName',
      null
    )
    if (
      configured.ok &&
      (configured.params.agentId !== PREFERRED_ICON_PARAMS.agentId ||
        configured.params.model !== PREFERRED_ICON_PARAMS.model)
    ) {
      const fallback = await generateWith(host, configured.params, name, signal)
      result = fallback.success
        ? fallback
        : { ...fallback, error: `${preferred.error}\n${fallback.error}` }
    }
  }
  if (signal.aborted) {
    return canceledResult()
  }
  if (result.success) {
    remember(host.cacheFile, name, result.svg)
  }
  return result
}

function forget(request: IconRequest): void {
  if (inFlight.get(request.name) === request) {
    inFlight.delete(request.name)
  }
}

// One agent at a time; canceled waiting cards are removed before they can acquire a process lane.
function drainQueue(): void {
  if (active) {
    return
  }
  const request = queued.values().next().value
  if (!request) {
    return
  }
  queued.delete(request)
  active = request
  void generate(request.host, request.name, request.controller.signal)
    .catch((error: unknown): WorktreeIconGenerationResult => ({
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }))
    .then((result) => {
      request.settled = true
      forget(request)
      request.result.resolve(result)
      active = undefined
      drainQueue()
    })
}

/** The cached icon for this name, or a queued generation that caches its result. */
export function generateWorktreeIconRequest(
  host: WorktreeIconGenerationHost,
  rawName: string,
  signal: AbortSignal
): Promise<WorktreeIconGenerationResult> {
  if (signal.aborted) {
    return Promise.resolve(canceledResult())
  }
  const name = normalizeWorktreeIconName(rawName)
  if (!name) {
    return Promise.resolve({ success: false, error: 'Workspace name is empty.' })
  }
  const cached = loadCache(host.cacheFile).get(name)
  if (cached) {
    return Promise.resolve({ success: true, svg: cached })
  }
  let request = inFlight.get(name)
  if (!request) {
    request = {
      host,
      name,
      controller: new AbortController(),
      consumers: 0,
      settled: false,
      result: Promise.withResolvers<WorktreeIconGenerationResult>()
    }
    inFlight.set(name, request)
    queued.add(request)
  }
  const owned = request
  owned.consumers++
  const result = new Promise<WorktreeIconGenerationResult>((resolve) => {
    let finished = false
    const finish = (result: WorktreeIconGenerationResult): void => {
      if (finished) {
        return
      }
      finished = true
      signal.removeEventListener('abort', cancel)
      owned.consumers--
      if (!owned.consumers && !owned.settled) {
        owned.controller.abort()
        queued.delete(owned)
        forget(owned)
        if (active === owned) {
          cancelLocalGeneration('worktree-icon', os.homedir())
        } else {
          owned.settled = true
          owned.result.resolve(canceledResult())
        }
      }
      resolve(result)
    }
    const cancel = (): void => finish(canceledResult())
    signal.addEventListener('abort', cancel, { once: true })
    void owned.result.promise.then(finish)
  })
  drainQueue()
  return result
}
