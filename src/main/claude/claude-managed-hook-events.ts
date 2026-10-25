import type { HookDefinition } from '../agent-hooks/installer-utils'
import {
  claudeKnowsHookEvent,
  claudeKnowsStatusLine,
  claudeVersionReaches,
  parseClaudeCliVersion
} from './claude-hook-event-versions'

export const CLAUDE_EVENTS = [
  // SessionStart creates sidebar rows for resumed or idle sessions before the first prompt.
  {
    eventName: 'SessionStart',
    definition: { hooks: [{ type: 'command', command: '' }] }
  },
  {
    eventName: 'UserPromptSubmit',
    definition: { hooks: [{ type: 'command', command: '' }] }
  },
  {
    eventName: 'Stop',
    definition: { hooks: [{ type: 'command', command: '' }] }
  },
  // OpenClaude emits StopFailure instead of Stop after API or model errors.
  {
    eventName: 'StopFailure',
    definition: { hooks: [{ type: 'command', command: '' }] }
  },
  // Child lifecycles track background work; TeammateIdle parks teammates whose rosters stay running.
  {
    eventName: 'SubagentStart',
    definition: { hooks: [{ type: 'command', command: '' }] }
  },
  {
    eventName: 'SubagentStop',
    definition: { hooks: [{ type: 'command', command: '' }] }
  },
  {
    eventName: 'TeammateIdle',
    definition: { hooks: [{ type: 'command', command: '' }] }
  },
  {
    eventName: 'PreToolUse',
    definition: { matcher: '*', hooks: [{ type: 'command', command: '' }] }
  },
  {
    eventName: 'PostToolUse',
    definition: { matcher: '*', hooks: [{ type: 'command', command: '' }] }
  },
  {
    eventName: 'PostToolUseFailure',
    definition: { matcher: '*', hooks: [{ type: 'command', command: '' }] }
  },
  {
    eventName: 'PermissionRequest',
    definition: { matcher: '*', hooks: [{ type: 'command', command: '' }] }
  },
  // Manual /compact may omit Stop; PostCompact clears the pane after completion.
  // PreCompact can fire on abort, so treating it as working would leave the pane stuck.
  {
    eventName: 'PostCompact',
    definition: { hooks: [{ type: 'command', command: '' }] }
  }
] as const

const CLAUDE_SESSION_END_EVENT = {
  eventName: 'SessionEnd',
  // Gate SessionEnd on measured delivery in 2.1.261, despite schema support since 1.0.85.
  installFrom: '2.1.261',
  definition: { hooks: [{ type: 'command', command: '' }] }
} as const

export const CLAUDE_MANAGED_EVENTS = [...CLAUDE_EVENTS, CLAUDE_SESSION_END_EVENT] as const

export type ManagedHookEvent = {
  eventName: string
  definition: Omit<HookDefinition, 'hooks'>
}

export type ClaudeManagedHookPlan = {
  install: readonly ManagedHookEvent[]
  /** Retire only Orca entries, preserving user hooks. */
  retire: readonly ManagedHookEvent[]
  /** Retire removes only Orca's entry; leave preserves the entire slot. */
  statusLine: 'install' | 'retire' | 'leave'
}

export function getClaudeManagedHookPlan(
  claudeVersion: string | null | undefined
): ClaudeManagedHookPlan {
  const install = CLAUDE_MANAGED_EVENTS.filter(
    (event) =>
      claudeKnowsHookEvent(claudeVersion, event.eventName) &&
      (!('installFrom' in event) || claudeVersionReaches(claudeVersion, event.installFrom))
  )
  // A failed version probe must not retire entries installed using a known version.
  const retire =
    parseClaudeCliVersion(claudeVersion) === null
      ? []
      : CLAUDE_MANAGED_EVENTS.filter((event) => !install.includes(event))
  return {
    install,
    retire,
    statusLine: claudeKnowsStatusLine(claudeVersion) ? 'install' : 'retire'
  }
}

// OpenClaude statusline data would be misattributed to Claude; leave its slot alone.
export const OPENCLAUDE_MANAGED_HOOK_PLAN: ClaudeManagedHookPlan = {
  install: CLAUDE_EVENTS,
  retire: [CLAUDE_SESSION_END_EVENT],
  statusLine: 'leave'
}
