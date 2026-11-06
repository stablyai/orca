import { isKnownHarnessInjectedUserTurnText } from '../../../src/shared/harness-injected-user-turns'
import { isGenericConversationTitle } from '../../../src/shared/project-conversation-list'
import type { Worktree } from '../worktree/workspace-list-types'
import type { ConversationHistory } from './conversation-records'

export function conversationTitle(
  values: readonly (string | null | undefined)[],
  workspace: Worktree,
  untitled: string
): string {
  return (
    values
      .map((value) => value?.trim())
      .find(
        (value) =>
          value &&
          !isGenericConversationTitle(value) &&
          value !== workspace.branch &&
          value !== workspace.path &&
          value !== workspace.displayName
      ) ?? untitled
  )
}

export function conversationUserPreview(prompt?: string | null, history?: ConversationHistory) {
  const savedPrompt =
    history?.lastUserPrompt === undefined
      ? history?.previewMessages.findLast(
          (message) =>
            message.role === 'user' &&
            message.text.trim() &&
            !isKnownHarnessInjectedUserTurnText(message.text)
        )?.text
      : history.lastUserPrompt
  return [prompt, savedPrompt]
    .find((text) => text?.trim() && !isKnownHarnessInjectedUserTurnText(text))
    ?.trim()
}
