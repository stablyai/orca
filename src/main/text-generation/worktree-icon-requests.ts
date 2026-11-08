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

export type WorktreeIconGenerationHost = {
  getSettings: () => Parameters<typeof resolveTextGenerationParams>[0]
  getAgentEnvironment: () => CommitMessageAgentEnvironmentResolvers | undefined
  cacheFile: string
}

const MAX_CACHED_ICONS = 500

let cache: Map<string, string> | null = null
const inFlight = new Map<string, Promise<WorktreeIconGenerationResult>>()
// One agent at a time: generation lanes cancel a same-cwd predecessor, and a sidebar of cards would fan out.
let queue: Promise<unknown> = Promise.resolve()

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
    icons.delete(icons.keys().next().value as string)
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
  name: string
): Promise<WorktreeIconGenerationResult> {
  const localEnv = await prepareLocalCommitMessageAgentEnv(
    params.agentId,
    host.getAgentEnvironment()
  )
  if (!localEnv.ok) {
    return { success: false, error: localEnv.error }
  }
  const result = await runGenerationRequest({
    params,
    prompt: buildWorktreeIconPrompt(name),
    target: { kind: 'local', cwd: os.homedir(), ...(localEnv.env ? { env: localEnv.env } : {}) },
    spawnAgent: spawnSourceControlAgent,
    operation: 'worktree-icon'
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
  name: string
): Promise<WorktreeIconGenerationResult> {
  const preferred = await generateWith(host, PREFERRED_ICON_PARAMS, name)
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
      const fallback = await generateWith(host, configured.params, name)
      result = fallback.success
        ? fallback
        : { ...fallback, error: `${preferred.error}\n${fallback.error}` }
    }
  }
  if (result.success) {
    remember(host.cacheFile, name, result.svg)
  }
  return result
}

/** The cached icon for this name, or a queued generation that caches its result. */
export function generateWorktreeIconRequest(
  host: WorktreeIconGenerationHost,
  rawName: string
): Promise<WorktreeIconGenerationResult> {
  const name = normalizeWorktreeIconName(rawName)
  if (!name) {
    return Promise.resolve({ success: false, error: 'Workspace name is empty.' })
  }
  const cached = loadCache(host.cacheFile).get(name)
  if (cached) {
    return Promise.resolve({ success: true, svg: cached })
  }
  const pending = inFlight.get(name)
  if (pending) {
    return pending
  }
  const run = queue
    .then(() => generate(host, name))
    .catch((error: unknown): WorktreeIconGenerationResult => ({
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }))
    .finally(() => inFlight.delete(name))
  queue = run
  inFlight.set(name, run)
  return run
}
