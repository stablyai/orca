// The newest release of each agent CLI users install themselves, looked up at most hourly.

import { z } from 'zod'
import { getMainHttpClient } from '../network/http-client'
import { CLAUDE_MANAGED_RUNTIME } from '../claude/managed-runtime/claude-managed-runtime'
import type { AgentCliUpdateAgent } from '../../shared/agent-launch/installation/agent-cli-update'

// Why GitHub: Codex's npm, Homebrew and standalone builds all publish from this release.
const CODEX_LATEST_RELEASE = 'https://api.github.com/repos/openai/codex/releases/latest'
const REFRESH_MS = 60 * 60_000

const codexReleaseSchema = z.object({ tag_name: z.string().regex(/^rust-v\d+\.\d+\.\d+$/) })

let codexLatest: { version: string | null; at: number } | null = null
let codexLookup: Promise<void> | null = null

async function fetchCodexLatest(): Promise<string> {
  const response = await getMainHttpClient().fetch(CODEX_LATEST_RELEASE, {
    headers: { Accept: 'application/vnd.github+json' }
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`Codex release lookup failed (${response.status})`)
  }
  return codexReleaseSchema.parse(await response.json()).tag_name.slice('rust-v'.length)
}

async function refreshCodexLatest(): Promise<string | null> {
  if (!codexLatest || Date.now() - codexLatest.at >= REFRESH_MS) {
    codexLookup ??= fetchCodexLatest()
      .then((version) => {
        codexLatest = { version, at: Date.now() }
      })
      .catch((error: unknown) => {
        // Waits out the hour too, so an offline host isn't asked again on every chat start.
        codexLatest = { version: codexLatest?.version ?? null, at: Date.now() }
        console.warn('[agent-cli-update] Codex release lookup failed:', error)
      })
      .finally(() => {
        codexLookup = null
      })
    await codexLookup
  }
  return codexLatest?.version ?? null
}

async function refreshClaudeLatest(): Promise<string | null> {
  // Shares Orca's own Claude lookup, which follows the user's update channel.
  await CLAUDE_MANAGED_RUNTIME.refreshPin?.().catch((error: unknown) => {
    console.warn('[agent-cli-update] Claude release lookup failed:', error)
  })
  return CLAUDE_MANAGED_RUNTIME.pin()?.version ?? null
}

export function latestAgentCliRelease(agent: AgentCliUpdateAgent): Promise<string | null> {
  return agent === 'claude' ? refreshClaudeLatest() : refreshCodexLatest()
}
