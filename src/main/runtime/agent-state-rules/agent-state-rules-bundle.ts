import { z } from 'zod'
import release from './agent-state-rules-release.json'
import { parseAgentStateRuleFiles } from './agent-state-rules-catalog'
import {
  AGENT_STATE_RULES_ENGINE_VERSION,
  type AgentStateRulesFile
} from './agent-state-rules-schema'

/**
 * The published bundle, `agent-state-rules.json`: the live-updatable agents' rule files, built by
 * config/scripts/agent-state-rules-bundle.mjs from the per-agent files and
 * agent-state-rules-release.json. `bundledOnly` tells apps to fall back to the rules they shipped.
 */

// Why a cap: the file comes off the network and is parsed on the main thread.
export const AGENT_STATE_RULES_BUNDLE_MAX_BYTES = 256 * 1024

/** The version of the rules this build ships; a download must be higher to replace them. */
export const BUNDLED_AGENT_STATE_RULES_VERSION: number = release.version

/** The rule files a rules release may carry: those the publish gate can replay transcripts for. */
export const LIVE_UPDATABLE_AGENT_STATE_RULE_IDS: ReadonlySet<string> = new Set(
  release.liveUpdatable
)

// Why the engine is checked here, before the files: a newer engine's files fail the file schema
// for a reason that is not theirs.
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

/**
 * Validates a bundle whole: a file that fails any check is rejected, never partly applied.
 * `any-agent` is for the local override, which the user chose, so it may carry any agent.
 */
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
