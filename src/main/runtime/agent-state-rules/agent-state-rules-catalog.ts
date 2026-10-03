import { AgentStateRulesFileSchema, type AgentStateRulesFile } from './agent-state-rules-schema'
import antigravity from './antigravity.json'
import claude from './claude.json'
import cline from './cline.json'
import codex from './codex.json'
import cursor from './cursor.json'
import gemini from './gemini.json'
import omp from './omp.json'
import opencode from './opencode.json'
import opencode2 from './opencode2.json'
import pi from './pi.json'
import primeAgent from './prime-agent.json'
import unknownPane from './unknown-pane.json'

/** Validates bundled rule files; a malformed one throws, naming the file and the bad field. */
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

// Why imported, not read from disk: the bundler inlines them, so packaged and headless builds
// carry the rules with no resource path to resolve.
export const BUNDLED_AGENT_STATE_RULE_FILES: readonly AgentStateRulesFile[] =
  parseAgentStateRuleFiles([
    antigravity,
    claude,
    cline,
    codex,
    cursor,
    gemini,
    omp,
    opencode,
    opencode2,
    pi,
    primeAgent,
    unknownPane
  ])
