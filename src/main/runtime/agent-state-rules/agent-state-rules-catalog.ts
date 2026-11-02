import { AgentStateRulesFileSchema, type AgentStateRulesFile } from './agent-state-rules-schema'
import antigravity from './antigravity.json'
import claude from './claude.json'
import cline from './cline.json'
import codex from './codex.json'
import cursor from './cursor.json'
import dsh from './dsh.json'
import gemini from './gemini.json'
import hermes from './hermes.json'
import omp from './omp.json'
import opencode from './opencode.json'
import opencode2 from './opencode2.json'
import pi from './pi.json'
import primeAgent from './prime-agent.json'
import unknownPane from './unknown-pane.json'

export function parseAgentStateRuleFiles(files: readonly unknown[]): AgentStateRulesFile[] {
  const parsed = files.map((file, index) => {
    const result = AgentStateRulesFileSchema.safeParse(file)
    if (!result.success) {
      throw new Error(`agent state rules file ${index}: ${result.error.message}`)
    }
    return result.data
  })
  const seen = new Set<AgentStateRulesFile['id']>()
  for (const file of parsed) {
    if (seen.has(file.id)) {
      throw new Error(`agent state rules: two files for ${file.id}`)
    }
    seen.add(file.id)
  }
  return parsed
}

/** The checked-in rule files exactly as bundled; the catalog test validates them against the schema. */
export const RAW_BUNDLED_AGENT_STATE_RULE_FILES: readonly unknown[] = [
  antigravity,
  claude,
  cline,
  codex,
  cursor,
  dsh,
  gemini,
  hermes,
  omp,
  opencode,
  opencode2,
  pi,
  primeAgent,
  unknownPane
]

// Inline imports keep packaged/headless builds independent of resource paths.
// Not parsed at load: zod-validating them cost ~25 ms of orcad startup on every launch.
export const BUNDLED_AGENT_STATE_RULE_FILES: readonly AgentStateRulesFile[] =
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: agent-state-rules-catalog.test.ts proves each bundled file parses and that the parse output deep-equals the raw JSON, and that the schema has no transform, default or coercion.
  RAW_BUNDLED_AGENT_STATE_RULE_FILES as readonly AgentStateRulesFile[]
