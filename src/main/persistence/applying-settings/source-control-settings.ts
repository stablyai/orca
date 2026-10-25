import type { GlobalSettings } from '../../../shared/global-settings-types'
import {
  mergeLegacyCommitMessageAiIntoSourceControlAi,
  normalizeSourceControlAiSettings,
  projectSourceControlAiToLegacyCommitMessageAi
} from '../../../shared/source-control-ai'
import {
  DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES,
  SOURCE_CONTROL_TEXT_ACTION_IDS
} from '../../../shared/source-control-ai-actions'

export function retireLegacyInstructionsForClearedTextActionRecipes(
  sourceControlAi: GlobalSettings['sourceControlAi'],
  previousSettings: GlobalSettings
): GlobalSettings['sourceControlAi'] {
  if (!sourceControlAi?.actions) {
    return sourceControlAi
  }

  const previousSourceControlAi = normalizeSourceControlAiSettings(
    previousSettings.sourceControlAi,
    previousSettings.commitMessageAi
  )
  let instructionsByOperation = sourceControlAi.instructionsByOperation
  let changed = false
  for (const actionId of SOURCE_CONTROL_TEXT_ACTION_IDS) {
    if (
      sourceControlAi.actions[actionId]?.commandInputTemplate !==
      DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES[actionId]
    ) {
      continue
    }
    if (
      previousSourceControlAi.actions?.[actionId]?.commandInputTemplate ===
        DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES[actionId] ||
      instructionsByOperation?.[actionId] !==
        previousSourceControlAi.instructionsByOperation[actionId]
    ) {
      continue
    }
    if (instructionsByOperation?.[actionId] === '') {
      continue
    }
    // Why: {basePrompt} is the explicit clear state; an empty instruction shadows rollback commitMessageAi.customPrompt on normalize/project.
    instructionsByOperation = { ...instructionsByOperation, [actionId]: '' }
    changed = true
  }

  return changed ? { ...sourceControlAi, instructionsByOperation } : sourceControlAi
}

export function applySourceControlAiSettingsUpdate(
  sanitizedUpdates: Partial<GlobalSettings>,
  previousSettings: GlobalSettings
): void {
  if ('sourceControlAi' in sanitizedUpdates) {
    sanitizedUpdates.sourceControlAi = retireLegacyInstructionsForClearedTextActionRecipes(
      sanitizedUpdates.sourceControlAi,
      previousSettings
    )
    const normalizedSourceControlAi = normalizeSourceControlAiSettings(
      sanitizedUpdates.sourceControlAi,
      previousSettings.commitMessageAi
    )
    sanitizedUpdates.sourceControlAi = normalizedSourceControlAi
    sanitizedUpdates.commitMessageAi = projectSourceControlAiToLegacyCommitMessageAi(
      normalizedSourceControlAi,
      previousSettings.commitMessageAi
    )
  } else if ('commitMessageAi' in sanitizedUpdates) {
    sanitizedUpdates.sourceControlAi = mergeLegacyCommitMessageAiIntoSourceControlAi(
      previousSettings.sourceControlAi,
      sanitizedUpdates.commitMessageAi
    )
  }
}
