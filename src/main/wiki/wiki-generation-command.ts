import type { TuiAgent } from '../../shared/types'

export type WikiHeadlessCommand = { args: string[]; promptViaStdin: boolean }

// Why: agentic file-writing in headless mode needs the agent's print/exec mode plus its
// permission-bypass flag. Only agents with a known headless-write invocation are supported.
export function buildWikiHeadlessArgs(agent: TuiAgent): WikiHeadlessCommand | null {
  switch (agent) {
    case 'claude':
    case 'openclaude':
    case 'claude-agent-teams':
      return { args: ['-p', '--dangerously-skip-permissions'], promptViaStdin: true }
    case 'codex':
      return {
        args: ['exec', '--dangerously-bypass-approvals-and-sandbox', '-'],
        promptViaStdin: true
      }
    default:
      return null
  }
}
