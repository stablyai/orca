import { describe, expect, it } from 'vitest'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import { ACP_LAUNCH_SPECS } from '../acp/launch/acp-launch-registry'
import { acpStructuredAgentDefinition } from '../acp/session/acp-structured-agent-definitions'
import { CLAUDE_STRUCTURED_AGENT } from '../claude/structured/claude-structured-agent-definition'
import { CODEX_STRUCTURED_AGENT } from '../codex/structured/launch/codex-structured-agent-definition'
import { PI_RPC_AGENT } from '../pi/rpc-agent-definition'
import { botSessionInstructions } from './bot-session-instructions'
import type { BotTurnContext } from './bot-turn-context'

describe('standing instructions on every start', () => {
  it('is declared by each agent as its delivery behaves', () => {
    const declared = Object.fromEntries(
      [
        CLAUDE_STRUCTURED_AGENT,
        CODEX_STRUCTURED_AGENT,
        PI_RPC_AGENT,
        ...ACP_LAUNCH_SPECS.map(acpStructuredAgentDefinition)
      ].map((definition) => [definition.agent, definition.instructionsEachStart])
    )
    expect(declared).toEqual({
      claude: false,
      codex: false,
      pi: true,
      grok: false,
      opencode: true,
      opencode2: true,
      omp: true,
      antigravity: true,
      copilot: true,
      kimi: false,
      // cursor-agent reads its rules once per process and keeps none with the session (#48693).
      cursor: true,
      hermes: false,
      kiro: false,
      goose: true,
      aug: true,
      kilo: true,
      'mimo-code': true,
      droid: true,
      'qwen-code': true,
      cline: true,
      devin: false,
      codebuddy: true
    })
  })

  it('makes a reopened chat count as given its Tools and Rules only when its agent declares it', async () => {
    const bot = { id: 'b1', name: 'Scout', agent: 'cursor' as const, folderWorkspaceId: 'home' }
    const launchedWith = async (instructionsEachStart: boolean) => {
      const launched: Parameters<BotTurnContext['launched']>[] = []
      await botSessionInstructions(
        {
          launched: (...args) => launched.push(args),
          linkedSkillsLaunched: () => {}
        },
        [bot],
        {
          sessionId: 's1',
          provider: 'cursor',
          instructionsKey: 'recorded-key',
          forkedFrom: undefined,
          location: { workspaceId: folderWorkspaceKey('home') },
          providerHandleChain: [{ nativeId: 'cursor-session' }],
          instructionsEachStart
        },
        '/bots/scout',
        null,
        { readText: async () => null }
      )
      const [, , , , startsFresh, rules] = launched[0]
      return { startsFresh, delivered: rules.delivered, rebuilt: rules.rebuilt }
    }
    expect(await launchedWith(true)).toEqual({ startsFresh: true, delivered: true, rebuilt: true })
    expect(await launchedWith(false)).toEqual({
      startsFresh: false,
      delivered: false,
      rebuilt: false
    })
  })
})
