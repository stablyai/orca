import type { TuiAgent } from '../../../../shared/tui-agent'

const HERDR_AGENT_KINDS = new Set([
  'amp',
  'claude',
  'cline',
  'codex',
  'copilot',
  'cursor',
  'devin',
  'droid',
  'gemini',
  'grok',
  'hermes',
  'kilo',
  'kimi',
  'kiro',
  'omp',
  'opencode',
  'pi'
])

export function herdrAgentKind(agent: TuiAgent | undefined): string | null {
  if (!agent || !HERDR_AGENT_KINDS.has(agent)) {
    return null
  }
  return agent
}

export function herdrAgentName(leafId: string): string {
  const slug = leafId.replace(/[^a-z0-9]/gi, '').toLowerCase()
  const body = (slug || 'pane').slice(0, 30)
  return `o${body}`.slice(0, 32)
}

export async function startHerdrAgentIfRequested(args: {
  sessionId?: string
  launchAgent?: TuiAgent
  command?: string
  sessionName: string
  leafId: string
  paneId: string
  request: (sessionName: string, method: string, params: unknown) => Promise<unknown>
  writeCommand: (text: string) => void
}): Promise<void> {
  if (args.sessionId) {
    return
  }
  const kind = herdrAgentKind(args.launchAgent)
  if (kind) {
    await args.request(args.sessionName, 'agent.start', {
      name: herdrAgentName(args.leafId),
      kind,
      pane_id: args.paneId
    })
    return
  }
  if (args.command) {
    args.writeCommand(`${args.command}\r`)
  }
}
