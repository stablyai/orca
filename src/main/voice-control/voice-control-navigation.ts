import { VOICE_NAVIGATE_VERBS, type VoiceNavigateVerb } from '../../shared/voice-control-types'

/**
 * The navigate_ui verb → ui channel map. Almost every channel already exists: the
 * renderer listens for each because the keyboard shortcuts and menu commands drive the
 * same messages (see `src/preload/api/ui-bridge-state-and-menu-commands.ts`); the one
 * addition, `ui:closeSettings`, mirrors the settings page's own back button. The voice
 * coordinator sends them through the same focusPane seam as agent pane focus.
 * `focus-agent` is the exception — it resolves a spoken name to pane messages
 * (`voice-control-pane-focus.ts`), so it has no static channel.
 */

export type VoiceNavigateSurface = {
  /** The ui:* channel the renderer already listens on. */
  channel: string
  /** Short noun for the pill's narration ("Navigating to the task list…"). */
  target: string
  /** Past-tense fragment for the model-facing output ("opened the task list"). */
  past: string
}

const NAVIGATE_SURFACES: Record<Exclude<VoiceNavigateVerb, 'focus-agent'>, VoiceNavigateSurface> = {
  'open-settings': { channel: 'ui:openSettings', target: 'settings', past: 'opened settings' },
  'close-settings': {
    channel: 'ui:closeSettings',
    target: 'the workspace',
    past: 'closed settings'
  },
  'quick-open': {
    channel: 'ui:openQuickOpen',
    target: 'the file picker',
    past: 'opened the file picker'
  },
  'worktree-palette': {
    channel: 'ui:toggleWorktreePalette',
    target: 'the worktree palette',
    past: 'toggled the worktree palette'
  },
  'floating-terminal': {
    channel: 'ui:toggleFloatingTerminal',
    target: 'the floating terminal',
    past: 'toggled the floating terminal'
  },
  tasks: { channel: 'ui:openTasks', target: 'the task list', past: 'opened the task list' },
  'agent-dashboard': {
    channel: 'ui:toggleAgentDashboard',
    target: 'the agent dashboard',
    past: 'toggled the agent dashboard'
  },
  'workspace-board': {
    channel: 'ui:openWorkspaceBoard',
    target: 'the workspace board',
    past: 'opened the workspace board'
  },
  'new-browser-tab': {
    channel: 'ui:newBrowserTab',
    target: 'a browser tab',
    past: 'opened a browser tab'
  },
  'toggle-left-sidebar': {
    channel: 'ui:toggleLeftSidebar',
    target: 'the left sidebar',
    past: 'toggled the left sidebar'
  },
  'toggle-right-sidebar': {
    channel: 'ui:toggleRightSidebar',
    target: 'the right sidebar',
    past: 'toggled the right sidebar'
  }
}

export function navigateSurfaceForVerb(
  verb: Exclude<VoiceNavigateVerb, 'focus-agent'>
): VoiceNavigateSurface {
  return NAVIGATE_SURFACES[verb]
}

/** Enum membership without assertions: narrows a wire-string verb to the closed set. */
export function isVoiceNavigateVerb(value: string): value is VoiceNavigateVerb {
  return VOICE_NAVIGATE_VERBS.some((verb) => verb === value)
}
