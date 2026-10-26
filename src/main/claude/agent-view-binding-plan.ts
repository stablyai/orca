import type { HooksConfig } from '../agent-hooks/installer-utils'
import { isPlainObject } from '../agent-hooks/hooks-json-read'
import { claudeAgentViewChord, serializeClaudeAgentViewBindings } from './agent-view-keybindings'
import {
  CLAUDE_AGENT_VIEW_COMMAND,
  CLAUDE_AGENT_VIEW_SHORTCUTS,
  normalizeClaudeAgentViewChord
} from '../../shared/claude-agent-view'

export function withClaudeAgentViewShortcut(config: HooksConfig): HooksConfig | null {
  const bindings = config.bindings ?? []
  if (
    !Array.isArray(bindings) ||
    bindings.some((block) => !isPlainObject(block) || !isPlainObject(block.bindings))
  ) {
    return null
  }
  const occupied = new Set<string>()
  for (const block of bindings) {
    for (const [chord, action] of Object.entries(block.bindings)) {
      if (block.context === 'Chat' && action === `command:${CLAUDE_AGENT_VIEW_COMMAND}`) {
        return config
      }
      occupied.add(normalizeClaudeAgentViewChord(chord))
    }
  }
  const shortcut = CLAUDE_AGENT_VIEW_SHORTCUTS.find(
    ({ chord }) =>
      ![...occupied].some(
        (key) =>
          key === normalizeClaudeAgentViewChord(chord) ||
          key.startsWith(`${normalizeClaudeAgentViewChord(chord)} `) ||
          normalizeClaudeAgentViewChord(chord).startsWith(`${key} `)
      )
  )
  return shortcut
    ? {
        ...config,
        bindings: [
          ...bindings,
          {
            context: 'Chat',
            bindings: { [shortcut.chord]: `command:${CLAUDE_AGENT_VIEW_COMMAND}` }
          }
        ]
      }
    : null
}

export const ownership = { owner: 'stablyai/orca/claude-agent-view' }
export const markerName = 'orca-agent-view.json'

function shortcutOwnership(config: HooksConfig, next: HooksConfig): HooksConfig {
  const block = config !== next && Array.isArray(next.bindings) ? next.bindings.at(-1) : undefined
  const chord =
    isPlainObject(block) && isPlainObject(block.bindings)
      ? Object.keys(block.bindings)[0]
      : undefined
  return {
    ...ownership,
    setup: 'attempted',
    ...(chord ? { binding: { context: 'Chat', chord } } : {})
  }
}

export function withoutOwnedBinding(config: HooksConfig, marker: HooksConfig): HooksConfig {
  const binding = isPlainObject(marker.binding) ? marker.binding : undefined
  if (marker.owner !== ownership.owner || !binding || !Array.isArray(config.bindings)) {
    return config
  }
  return {
    ...config,
    bindings: config.bindings.flatMap((block) => {
      if (!isPlainObject(block) || !isPlainObject(block.bindings)) {
        return [block]
      }
      const remaining = Object.fromEntries(
        Object.entries(block.bindings).filter(
          ([chord, action]) =>
            block.context !== binding.context ||
            chord !== binding.chord ||
            action !== `command:${CLAUDE_AGENT_VIEW_COMMAND}`
        )
      )
      if (Object.keys(remaining).length === Object.keys(block.bindings).length) {
        return [block]
      }
      return Object.keys(remaining).length === 0 &&
        Object.keys(block).every((key) => key === 'context' || key === 'bindings')
        ? []
        : [{ ...block, bindings: remaining }]
    })
  }
}

export function planClaudeAgentViewInstall(
  raw: string | null,
  config: HooksConfig,
  previous: HooksConfig | null | undefined
): { config: HooksConfig; marker?: HooksConfig; supported: boolean } {
  if (
    previous !== undefined &&
    (previous?.owner !== ownership.owner || previous.setup !== 'pending')
  ) {
    return { config, supported: claudeAgentViewChord(raw ?? '') !== undefined }
  }
  const next = withClaudeAgentViewShortcut(config)
  if (!next) {
    return { config, supported: false }
  }
  return {
    config: next,
    marker:
      config === next && previous?.owner === ownership.owner
        ? { ...previous, setup: 'attempted', cleanupPending: false }
        : shortcutOwnership(config, next),
    supported: claudeAgentViewChord(serializeClaudeAgentViewBindings(raw, next)) !== undefined
  }
}

export function planClaudeAgentViewDisable(
  config: HooksConfig | null,
  marker: HooksConfig
): { config: HooksConfig | null; marker: HooksConfig } {
  const next = config && withoutOwnedBinding(config, marker)
  const removed = config && JSON.stringify(config) !== JSON.stringify(next)
  return {
    config: next,
    marker: { ...marker, ...(removed ? { setup: 'pending' } : {}), cleanupPending: !config }
  }
}
