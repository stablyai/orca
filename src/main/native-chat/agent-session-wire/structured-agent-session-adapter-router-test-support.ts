import { CLAUDE_STRUCTURED_AGENT } from '../../claude/claude-structured-agent-definition'
import { CODEX_STRUCTURED_AGENT } from '../../codex/codex-structured-agent-definition'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionAdapterRouter } from './structured-agent-session-adapter-router'
import type { StructuredAgentDefinition } from './structured-agent-definition'
import { StructuredAgentRegistry } from './structured-agent-registry'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the registry reads only the optional methods a declaration needs; this double has none, so its agents declare none.
const NO_METHODS = {} as StructuredAgentSessionAdapter

/** This build's agent as a host over a bare adapter double registers it: who it is (so its chats
 *  start), and nothing it can do. */
function declaringNothing(definition: StructuredAgentDefinition): StructuredAgentDefinition {
  return {
    ...definition,
    capabilities: {
      rewind: false,
      compact: false,
      threadGoal: false,
      contextUsage: false,
      imagePrompts: false,
      steering: definition.capabilities.steering,
      approvalEnforcement: definition.capabilities.approvalEnforcement
    },
    restingOptions: {
      acceptsKey: () => false,
      fallbackModels: () => null,
      effortDefaultsToModel: false
    }
  }
}

/** Claude and Codex declaring no capability and no resting options: what a host over a bare
 *  adapter double declares. */
export const NO_STRUCTURED_AGENTS = new StructuredAgentRegistry([
  { definition: declaringNothing(CLAUDE_STRUCTURED_AGENT), adapter: NO_METHODS },
  { definition: declaringNothing(CODEX_STRUCTURED_AGENT), adapter: NO_METHODS }
])

/** This build's two agents over doubles. Each declares only what its double implements, so a
 *  double need not carry every method its real adapter has. */
export function claudeAndCodexAgents(
  adapters:
    | { claude: StructuredAgentSessionAdapter; codex: StructuredAgentSessionAdapter }
    | StructuredAgentSessionAdapter = NO_METHODS
): StructuredAgentRegistry {
  const { claude, codex } = 'claude' in adapters ? adapters : { claude: adapters, codex: adapters }
  return new StructuredAgentRegistry([
    { definition: implementedBy(CLAUDE_STRUCTURED_AGENT, claude), adapter: claude },
    { definition: implementedBy(CODEX_STRUCTURED_AGENT, codex), adapter: codex }
  ])
}

/** This build's two agents exactly as declared, for a host whose double gains its methods per test. */
export function claudeAndCodexDeclared(): StructuredAgentRegistry {
  const unused = (): never => {
    throw new Error('a registry never calls its adapters')
  }
  return claudeAndCodexAgents({
    ...NO_METHODS,
    compact: unused,
    changeThreadGoal: unused,
    rewind: unused,
    recoverRewind: unused
  })
}

/** A router over this build's two agents. */
export function claudeAndCodexRouter(
  adapters: { claude: StructuredAgentSessionAdapter; codex: StructuredAgentSessionAdapter },
  closeAdapters: () => Promise<void>
): StructuredAgentSessionAdapterRouter {
  return new StructuredAgentSessionAdapterRouter(claudeAndCodexAgents(adapters), closeAdapters)
}

function implementedBy(
  definition: StructuredAgentDefinition,
  adapter: StructuredAgentSessionAdapter
): StructuredAgentDefinition {
  const declared = definition.capabilities
  return {
    ...definition,
    capabilities: {
      ...declared,
      compact: declared.compact && Boolean(adapter.compact),
      threadGoal: declared.threadGoal && Boolean(adapter.changeThreadGoal),
      rewind: declared.rewind && Boolean(adapter.rewind && adapter.recoverRewind)
    }
  }
}
