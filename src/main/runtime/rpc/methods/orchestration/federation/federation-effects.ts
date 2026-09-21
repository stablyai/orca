export type FederationEffect = {
  kind: 'worktree' | 'terminal' | 'setup' | 'dispatch_input'
  action?: string
  role?: string
  id?: string
  state?: string
  tabId?: string
  leafId?: string
  requested?: string
  effective?: string
  source?: string
  hookFound?: boolean
  startupPolicy?: string
  terminalId?: string
}

export function appendFederationTerminalEffects(
  effects: FederationEffect[],
  terminals: { handle: string; title: string | null; tabId?: string; leafId?: string }[],
  agentHandle: string,
  setupHandle?: string
): void {
  for (const terminal of terminals) {
    effects.push({
      kind: 'terminal',
      role:
        terminal.handle === agentHandle
          ? 'agent'
          : terminal.handle === setupHandle
            ? 'setup'
            : 'configured_tab',
      action: terminal.handle === agentHandle ? 'reused_agent_terminal' : 'created',
      id: terminal.handle,
      tabId: terminal.tabId,
      leafId: terminal.leafId
    })
  }
}

export function appendFederationSetupEffect(
  effects: FederationEffect[],
  setup: {
    requested: string
    effective: string
    source: string
    hookFound: boolean
    startupPolicy: string
    state: string
  }
): void {
  const setupTerminal = effects.find(
    (effect) => effect.kind === 'terminal' && effect.role === 'setup'
  )
  effects.push({
    kind: 'setup',
    action: setup.requested,
    ...setup,
    terminalId: setupTerminal?.id
  })
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
