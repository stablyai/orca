import {
  applyPickerSuggestion,
  type ComposerAutocomplete,
  type NativeChatPickerItem
} from '../../../src/shared/native-chat/native-chat-composer-state'
import type { SkillSourceKind } from '../../../src/shared/skills'

export type MobileNativeChatPickerAutocomplete = Extract<
  ComposerAutocomplete,
  { mode: 'slash' | 'skill' }
>

export type MobileNativeChatPickerPresentation = {
  commands: Extract<NativeChatPickerItem, { kind: 'command' }>[]
  skills: Extract<NativeChatPickerItem, { kind: 'skill' }>[]
  showCommandsHeading: boolean
  showSkillsHeading: boolean
  statusText: string | null
  statusKind: 'loading' | 'error' | 'empty' | null
  canRetry: boolean
}

export function buildMobileNativeChatPickerPresentation(
  autocomplete: MobileNativeChatPickerAutocomplete
): MobileNativeChatPickerPresentation {
  const commands = autocomplete.items.filter(
    (item): item is Extract<NativeChatPickerItem, { kind: 'command' }> => item.kind === 'command'
  )
  const skills = autocomplete.items.filter(
    (item): item is Extract<NativeChatPickerItem, { kind: 'skill' }> => item.kind === 'skill'
  )
  const hasSkillStatus =
    autocomplete.skillStatus === 'loading' || autocomplete.skillStatus === 'error'
  const noMatches =
    autocomplete.skillStatus === 'ready' && commands.length === 0 && skills.length === 0
  const statusKind =
    autocomplete.skillStatus === 'loading'
      ? 'loading'
      : autocomplete.skillStatus === 'error'
        ? 'error'
        : noMatches
          ? 'empty'
          : null
  return {
    commands,
    skills,
    showCommandsHeading: autocomplete.grouped && commands.length > 0,
    showSkillsHeading: autocomplete.grouped && (skills.length > 0 || hasSkillStatus),
    statusText:
      statusKind === 'loading'
        ? 'Loading skills...'
        : statusKind === 'error'
          ? autocomplete.skillErrorKind === 'unavailable'
            ? 'Skills are unavailable for this host'
            : 'Could not load skills from this host'
          : statusKind === 'empty'
            ? getPickerEmptyText(autocomplete)
            : null,
    statusKind,
    canRetry: statusKind === 'error' && autocomplete.skillErrorKind !== 'unavailable'
  }
}

export function insertMobileNativeChatPickerItem(
  draft: string,
  caret: number,
  autocomplete: MobileNativeChatPickerAutocomplete,
  item: NativeChatPickerItem
): { text: string; cursor: number; insertedToken: string } {
  const result = applyPickerSuggestion(draft, caret, item, autocomplete.prefix)
  return { text: result.draft, cursor: result.caret, insertedToken: result.insertedToken }
}

export function mobileNativeChatPickerAnnotation(item: NativeChatPickerItem): string | null {
  if (item.kind === 'command' && item.skillCollision) {
    return 'Also a skill name - agent decides'
  }
  if (item.kind === 'skill' && item.sources.length > 1) {
    return `${item.sources.length} sources - agent resolves`
  }
  return null
}

export function mobileNativeChatSkillScopeLabel(sourceKind: SkillSourceKind | undefined): string {
  const labels: Record<SkillSourceKind, string> = {
    repo: 'Project',
    home: 'Personal',
    bundled: 'Built-in',
    plugin: 'Plugin'
  }
  return sourceKind ? labels[sourceKind] : ''
}

function getPickerEmptyText(autocomplete: MobileNativeChatPickerAutocomplete): string {
  if (autocomplete.mode === 'skill' || !autocomplete.commandsEnabled) {
    return 'No matching skills'
  }
  if (autocomplete.skillsEnabled) {
    return 'No matching commands or skills'
  }
  return 'No matching commands'
}
