import type { HookDefinition } from '../agent-hooks/installer-utils'
import {
  claudeKnowsHookEvent,
  claudeKnowsStatusLine,
  claudeVersionReaches,
  parseClaudeCliVersion
} from './claude-hook-event-versions'

export const CLAUDE_EVENTS = [
  // Why: SessionStart is the only event a resumed/idle session emits before the
  // first prompt; without it the sidebar row can't exist until the user types (STA-3386).
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
  // Why: OpenClaude skips normal Stop hooks after API/model errors and emits
  // StopFailure instead; without this hook Orca leaves the turn spinning.
  {
    eventName: 'StopFailure',
    definition: { hooks: [{ type: 'command', command: '' }] }
  },
  // Why: subagent/teammate lifecycle feeds the sidebar's child rows and keeps
  // a pane 'working' while background children outlive the lead's turn.
  // TeammateIdle parks turn-based teammates without trusting their permanently
  // "running" background_tasks entry to gate the pane.
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
  // Why: PreToolUse gives the dashboard a live readout of the in-flight tool
  // (name + input preview) before it completes.
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
  // Why: a manual /compact ends at an idle prompt without emitting Stop, so PostCompact is the only
  // signal that can clear the pane (STA-2915). PreCompact is deliberately NOT registered: it fires
  // before the compact is validated, and an aborted compact emits it alone — mapping it to 'working'
  // would strand the pane exactly as this registration is meant to prevent (STA-4613).
  {
    eventName: 'PostCompact',
    definition: { hooks: [{ type: 'command', command: '' }] }
  }
] as const

const CLAUDE_SESSION_END_EVENT = {
  eventName: 'SessionEnd',
  // Why: Claude knows SessionEnd from 1.0.85, but 2.1.261 is the only version its delivery was measured on.
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
  /** Events whose Orca entry must go; user entries under them always stay. */
  retire: readonly ManagedHookEvent[]
  /** Orca's statusLine usage feed; `retire` removes only Orca's own, `leave` never touches the slot. */
  statusLine: 'install' | 'retire' | 'leave'
}

/** What to write for a Claude of this version; see claude-hook-event-versions.ts. */
export function getClaudeManagedHookPlan(
  claudeVersion: string | null | undefined
): ClaudeManagedHookPlan {
  const install = CLAUDE_MANAGED_EVENTS.filter(
    (event) =>
      claudeKnowsHookEvent(claudeVersion, event.eventName) &&
      (!('installFrom' in event) || claudeVersionReaches(claudeVersion, event.installFrom))
  )
  // Why: an unresolved version (e.g. a probe timeout) is no evidence of an old Claude, so it must
  // not strip entries an install that knew the version wrote; only a known version retires events.
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

// OpenClaude has separate settings and its statusline reports its own provider identity.
export const OPENCLAUDE_MANAGED_HOOK_PLAN: ClaudeManagedHookPlan = {
  install: CLAUDE_EVENTS,
  retire: [CLAUDE_SESSION_END_EVENT],
  statusLine: 'install'
}
