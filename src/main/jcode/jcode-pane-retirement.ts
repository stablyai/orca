import type { AgentHookServer } from '../agent-hooks/server'
import type { forgetJcodePaneSecret } from './jcode-pane-secrets'

export type JcodeRetirementDeps = {
  runtime: {
    getTerminalHandleForPaneKey(paneKey: string): string | null
    closeTerminalTab(handle: string): Promise<unknown>
    clearExternalAgentParentLink(paneKey: string): void
  }
  server: Pick<
    AgentHookServer,
    | 'jcodePaneRetirementState'
    | 'jcodeDisplayPanesOfRoot'
    | 'clearJcodeDisplayBindingsOfRoot'
    | 'closeJcodeSessionTab'
    | 'settleJcodeDisplayPane'
    | 'clearPaneState'
  >
  isQuitting(): boolean
  forgetJcodePaneSecret: typeof forgetJcodePaneSecret
}

type JcodeCleanupStep =
  | 'forget secret'
  | 'read retirement state'
  | 'close child'
  | 'clear parent link'
  | 'clear root bindings'
  | 'clear pane state'
  | 'close session owner'
  | 'settle display binding'
  | 'release session owner'
  | 'close terminal'

export function bestEffortJcodeCleanup(step: JcodeCleanupStep, action: () => unknown): void {
  const warn = () => console.warn(`[jcode-spawn] Pane cleanup failed: ${step}`)
  try {
    void Promise.resolve(action()).catch(warn)
  } catch {
    warn()
  }
}

export function retireJcodePane(deps: JcodeRetirementDeps, paneKey: string): void {
  const { runtime, server } = deps
  bestEffortJcodeCleanup('forget secret', () => deps.forgetJcodePaneSecret(paneKey))
  let children: string[] = []
  let openChildren = new Set<string>()
  let hasOwner = false
  let hasBinding = false
  let hasRootBindings = false
  bestEffortJcodeCleanup('read retirement state', () => {
    children = server.jcodeDisplayPanesOfRoot(paneKey)
    ;({ openChildren, hasOwner, hasBinding, hasRootBindings } =
      server.jcodePaneRetirementState(paneKey))
  })
  for (const child of children) {
    if (!deps.isQuitting() && openChildren.has(child)) {
      bestEffortJcodeCleanup('close child', () => {
        const handle = runtime.getTerminalHandleForPaneKey(child)
        return handle ? runtime.closeTerminalTab(handle) : undefined
      })
    }
    bestEffortJcodeCleanup('clear parent link', () => runtime.clearExternalAgentParentLink(child))
  }
  if (children.length || hasRootBindings) {
    bestEffortJcodeCleanup('clear root bindings', () =>
      server.clearJcodeDisplayBindingsOfRoot(paneKey)
    )
    for (const child of children) {
      bestEffortJcodeCleanup('clear pane state', () => server.clearPaneState(child))
    }
  }
  if (hasOwner) {
    bestEffortJcodeCleanup('close session owner', () => server.closeJcodeSessionTab(paneKey))
  }
  if (hasBinding) {
    bestEffortJcodeCleanup('settle display binding', () => server.settleJcodeDisplayPane(paneKey))
  }
  if (children.length || hasRootBindings || hasOwner || hasBinding) {
    bestEffortJcodeCleanup('clear parent link', () => runtime.clearExternalAgentParentLink(paneKey))
    // Retirement can recreate session-routing tombstones after provider cleanup already ran.
    bestEffortJcodeCleanup('clear pane state', () => server.clearPaneState(paneKey))
  }
}
