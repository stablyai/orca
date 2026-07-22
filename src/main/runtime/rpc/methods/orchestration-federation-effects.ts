export type FederationEffect = {
  kind: 'worktree' | 'terminal' | 'setup' | 'dispatch_input'
  action?: string
  role?: string
  id?: string
  state?: string
}

export function appendFederationTerminalEffects(
  effects: FederationEffect[],
  terminals: { handle: string; title: string | null }[],
  agentHandle: string
): void {
  for (const terminal of terminals) {
    effects.push({
      kind: 'terminal',
      role:
        terminal.handle === agentHandle
          ? 'agent'
          : terminal.title === 'Setup'
            ? 'setup'
            : 'configured_tab',
      action: terminal.handle === agentHandle ? 'reused_agent_terminal' : 'created',
      id: terminal.handle
    })
  }
}

export function isFederationResidualEffect(effect: FederationEffect): boolean {
  return Boolean(effect.action?.startsWith('created') || effect.action === 'reused_agent_terminal')
}

export function isFederationEffectUnknown(error: unknown, stage: string): boolean {
  const code =
    error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : ''
  if (code === 'operation_unknown') {
    return true
  }
  if (!['worktree_create', 'terminal_create', 'dispatch_input'].includes(stage)) {
    return false
  }
  const message = error instanceof Error ? error.message : String(error)
  return /connection|disconnect|timed?\s*out|runtime changed|outcome unknown/i.test(message)
}
