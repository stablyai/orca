/**
 * Phase 4 — installing `officecli`'s own agent skills.
 *
 * Orca authors no Office skill content and registers no MCP server. It enumerates what the tool
 * offers and runs the tool's installer on the workspace's execution host, so a `officecli` update
 * that adds a skill does not silently make this UI wrong.
 */
import {
  officeFailure,
  type OfficeSkillAgent,
  type OfficeSkillCatalogOutcome,
  type OfficeSkillInstallOutcome,
  type OfficeSkillInstallResult
} from '../../shared/office-preview-contracts'
import { classifyOfficeThrown } from './office-error-codes'
import { officecliSkillsInstallArgs, officecliSkillsListArgs } from './officecli-argv'
import { NATIVE_OFFICECLI_LANE, type OfficecliLane } from './officecli-lane'
import { runOfficecli } from './officecli-invocation'

const SKILLS_TIMEOUT_MS = 60_000

/** `all` is the tool's fan-out target, not an agent; offering it as a checkbox reads as a product. */
const PSEUDO_AGENT_IDS = new Set(['all'])

/**
 * `skills list` prints usage plus two comma-separated lines. It has no `--json` mode on 1.0.148 —
 * passing the flag prints the same usage — so the lines are parsed rather than deserialised.
 */
export function parseOfficeSkillCatalog(stdout: string): {
  skills: string[]
  agents: string[]
} {
  const line = (label: string): string[] => {
    const match = new RegExp(`^\\s*${label}:\\s*(.+)$`, 'mi').exec(stdout)
    return (match?.[1] ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0 && !entry.includes(' '))
  }
  return { skills: line('Skills'), agents: line('Agents') }
}

export async function listOfficeSkills(
  lane: OfficecliLane = NATIVE_OFFICECLI_LANE
): Promise<OfficeSkillCatalogOutcome> {
  try {
    const run = await runOfficecli(officecliSkillsListArgs(), {
      lane,
      timeoutMs: SKILLS_TIMEOUT_MS,
      maxOutputBytes: 256 * 1024
    })
    const catalog = parseOfficeSkillCatalog(`${run.stdout}\n${run.stderr}`)
    if (catalog.skills.length === 0) {
      // An empty catalogue is not an empty product: it means the output shape moved, and offering
      // an empty picker would read as "this tool has no skills".
      return officeFailure('OFFICECLI_RENDER_FAILED', run.stderr.trim() || 'No skills listed')
    }
    const agents: OfficeSkillAgent[] = catalog.agents
      .filter((id) => !PSEUDO_AGENT_IDS.has(id))
      .map((id) => ({ id, label: null, detected: false }))
    return {
      ok: true,
      skills: catalog.skills.map((id) => ({ id, description: null })),
      agents
    }
  } catch (error) {
    return classifyOfficeThrown(error, 'inspect')
  }
}

export async function installOfficeSkills(
  pairs: readonly { skill: string; agent: string }[],
  lane: OfficecliLane = NATIVE_OFFICECLI_LANE
): Promise<OfficeSkillInstallOutcome> {
  const results: OfficeSkillInstallResult[] = []
  for (const pair of pairs) {
    try {
      const run = await runOfficecli(officecliSkillsInstallArgs(pair.skill, pair.agent), {
        lane,
        timeoutMs: SKILLS_TIMEOUT_MS,
        maxOutputBytes: 256 * 1024
      })
      const detail = `${run.stdout}\n${run.stderr}`.trim().slice(0, 400)
      results.push({
        skill: pair.skill,
        agent: pair.agent,
        installed: run.code === 0,
        detail: detail || null
      })
    } catch (error) {
      const failure = classifyOfficeThrown(error, 'inspect')
      if (failure.code === 'OFFICECLI_NOT_FOUND') {
        // Nothing after this can succeed either; reporting per-pair would bury the one real cause.
        return failure
      }
      results.push({
        skill: pair.skill,
        agent: pair.agent,
        installed: false,
        detail: failure.detail ?? null
      })
    }
  }
  // Per-pair reporting on purpose: one agent refusing must not read as the whole action failing.
  return { ok: true, results }
}
