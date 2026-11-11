// GET /v1/models (MCP list_models): the agents a cloud workspace runs and the models/efforts each
// accepts. Built from the same seed catalogs the desktop's model picker uses, so the two never
// disagree; the VM's own CLI may know newer models, which session create also accepts.
import {
  CLAUDE_SESSION_OPTION_CATALOG,
  CODEX_SESSION_OPTION_CATALOG
} from '../../../../../src/shared/agent-session/options/agent-session-option-catalog-claude-codex'
import {
  CURSOR_SESSION_OPTION_CATALOG,
  GEMINI_SESSION_OPTION_CATALOG
} from '../../../../../src/shared/agent-session/options/agent-session-option-catalog-gemini-cursor'
import { OPENCODE_LAUNCH_OPTION_CATALOG } from '../../../../../src/shared/agent-session/options/agent-session-option-catalog-opencode'
import type { AgentSessionOptionCatalog, CatalogModel } from '../../../../../src/shared/agent-session/options/agent-session-option-catalog-types'
import { AGENTS, type AgentId } from './vm-agent'

const LABELS: Record<AgentId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  gemini: 'Gemini CLI',
  cursor: 'Cursor',
  copilot: 'GitHub Copilot'
}

const CATALOGS: Partial<Record<AgentId, AgentSessionOptionCatalog>> = {
  claude: CLAUDE_SESSION_OPTION_CATALOG,
  codex: CODEX_SESSION_OPTION_CATALOG,
  gemini: GEMINI_SESSION_OPTION_CATALOG,
  cursor: CURSOR_SESSION_OPTION_CATALOG,
  opencode: OPENCODE_LAUNCH_OPTION_CATALOG
}

/** Model ids travel as one argv entry (`--model=<id>`); this keeps them to what agent CLIs use. */
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,127}$/
export const EFFORT_ID = /^[a-z]{2,16}$/

function modelView(model: CatalogModel) {
  const effort = model.options.find((option) => option.id === 'effort')
  const efforts = effort?.kind.type === 'select' ? effort.kind.choices.map((choice) => String(choice.value)) : []
  return {
    id: model.id,
    label: model.label,
    description: model.description ?? null,
    default: model.isDefault === true,
    efforts,
    defaultEffort: effort?.kind.type === 'select' ? effort.kind.defaultValue : null,
    fastMode: model.options.some((option) => option.id === 'fastMode' || option.id === 'serviceTier')
  }
}

export type ModelsView = ReturnType<typeof modelsView>

export function modelsView() {
  return {
    agents: AGENTS.map((agent) => {
      const models = (CATALOGS[agent]?.models ?? []).map(modelView)
      return {
        id: agent,
        label: LABELS[agent],
        default: agent === 'claude',
        // Null: the agent's own default (its CLI picks; nothing is passed).
        defaultModel: models.find((model) => model.default)?.id ?? null,
        models
      }
    })
  }
}

/** The efforts the catalog lists for this agent's model, or null when it lists none (any is passed through). */
export function knownEfforts(agent: AgentId, model: string): string[] | null {
  const found = CATALOGS[agent]?.models.find((candidate) => candidate.id === model)
  if (!found) {
    return null
  }
  const efforts = modelView(found).efforts
  return efforts.length > 0 ? efforts : []
}
