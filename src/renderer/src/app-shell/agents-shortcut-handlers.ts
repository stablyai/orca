import { AI_VAULT_SCOPE_STEP_EVENT } from '@/components/right-sidebar/ai-vault-scope-state'
import { focusActiveTabSurface } from '@/lib/focus-active-tab-surface'
import { textKeyComposesCharacter } from '@/lib/file-search-shortcut-policy'
import type { KeybindingActionId } from '../../../shared/keybindings'

export const AGENTS_SHORTCUT_ACTION_IDS = [
  'sidebar.agents.toggle',
  'sidebar.agents.scopeNext',
  'sidebar.agents.scopePrevious'
] as const satisfies readonly KeybindingActionId[]

// Why: once focus returns to a tab, the scope chords belong to tab switching again.
function agentsPanelHasFocus(): boolean {
  return document.activeElement?.closest('[data-ai-vault-panel]') != null
}

// Why: a chord bound to an Agents action runs from the focused Agents search field, except keys that type or compose a character.
export function agentsPanelClaimsChord(
  matchShortcut: (actionId: KeybindingActionId) => boolean,
  input: Parameters<typeof textKeyComposesCharacter>[0]
): boolean {
  return (
    AGENTS_SHORTCUT_ACTION_IDS.some((actionId) => matchShortcut(actionId)) &&
    agentsPanelHasFocus() &&
    !textKeyComposesCharacter(input)
  )
}

export function agentsScopeShortcutOwnsChord(
  matchShortcut: (actionId: KeybindingActionId) => boolean
): boolean {
  return (
    (matchShortcut('sidebar.agents.scopeNext') || matchShortcut('sidebar.agents.scopePrevious')) &&
    agentsPanelHasFocus()
  )
}

export function agentsShortcutHandlers(args: {
  canRevealRightSidebar: boolean
  claim: (actionId: KeybindingActionId, run: () => void) => boolean
  showAiVaultSearch: () => void
  closeRightSidebar: () => void
}): [KeybindingActionId, () => boolean][] {
  const scopeStep = (actionId: KeybindingActionId, step: 1 | -1) => (): boolean =>
    args.canRevealRightSidebar && agentsPanelHasFocus()
      ? args.claim(actionId, () =>
          window.dispatchEvent(new CustomEvent(AI_VAULT_SCOPE_STEP_EVENT, { detail: step }))
        )
      : false
  return [
    [
      'sidebar.agents.toggle',
      () =>
        args.canRevealRightSidebar
          ? args.claim('sidebar.agents.toggle', () => {
              // Why: an open Agents tab that lost focus to a tab is made active again; only a focused one closes.
              if (agentsPanelHasFocus()) {
                args.closeRightSidebar()
                focusActiveTabSurface()
              } else {
                args.showAiVaultSearch()
              }
            })
          : false
    ],
    ['sidebar.agents.scopeNext', scopeStep('sidebar.agents.scopeNext', 1)],
    ['sidebar.agents.scopePrevious', scopeStep('sidebar.agents.scopePrevious', -1)]
  ]
}
