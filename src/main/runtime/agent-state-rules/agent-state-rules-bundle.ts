import { z } from 'zod'
import release from './agent-state-rules-release.json'
import { parseAgentStateRuleFiles } from './agent-state-rules-catalog'
import {
  AGENT_STATE_RULES_ENGINE_VERSION,
  type AgentStateRulesFile
} from './agent-state-rules-schema'

/** Published live-update envelope; bundledOnly forces shipped-rule fallback. */

// Network input is parsed on the main thread.
export const AGENT_STATE_RULES_BUNDLE_MAX_BYTES = 256 * 1024

export const BUNDLED_AGENT_STATE_RULES_VERSION: number = release.version

/** Only agents covered by the release gate's transcript replay. */
export const LIVE_UPDATABLE_AGENT_STATE_RULE_IDS: ReadonlySet<string> = new Set(
  release.liveUpdatable
)

// Check engine compatibility first so newer formats are not misreported as malformed files.
const BundleEnvelopeSchema = z
  .object({
    version: z.number().int().positive(),
    engineVersion: z.literal(AGENT_STATE_RULES_ENGINE_VERSION),
    bundledOnly: z.boolean().optional(),
    files: z.array(z.unknown())
  })
  .strict()

export type AgentStateRulesBundle = {
  version: number
  bundledOnly: boolean
  files: readonly AgentStateRulesFile[]
}

export type AgentStateRulesBundleParse =
  | { ok: true; bundle: AgentStateRulesBundle }
  | { ok: false; error: string }

/** Reject the entire bundle on any failure; user-selected overrides may carry any agent. */
export function parseAgentStateRulesBundle(
  text: string,
  scope: 'live-updatable' | 'any-agent'
): AgentStateRulesBundleParse {
  if (Buffer.byteLength(text, 'utf8') > AGENT_STATE_RULES_BUNDLE_MAX_BYTES) {
    return { ok: false, error: `larger than ${AGENT_STATE_RULES_BUNDLE_MAX_BYTES} bytes` }
  }
  try {
    const { version, bundledOnly, files } = BundleEnvelopeSchema.parse(JSON.parse(text))
    const parsed = parseAgentStateRuleFiles(files)
    const outside = parsed.find((file) => !LIVE_UPDATABLE_AGENT_STATE_RULE_IDS.has(file.id))
    if (scope === 'live-updatable' && outside) {
      return { ok: false, error: `carries ${outside.id}, which has no transcript suite to gate it` }
    }
    return { ok: true, bundle: { version, bundledOnly: bundledOnly ?? false, files: parsed } }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
