import { BUILT_IN_EDITOR_COMMANDS } from '../../shared/open-in-applications'
import type { OpenInApplication } from '../../shared/ui-chrome-types'
import type { ShellOpenExternalEditorRequest } from '../../shared/shell-open-types'

type EditorSelection = Pick<
  ShellOpenExternalEditorRequest,
  'openInApplicationId' | 'builtInEditorId' | 'command'
>

/** Main picks the command line; the caller may only name a saved or built-in editor. */
export function resolveOpenInEditorCommand(
  request: EditorSelection,
  savedApplications: readonly OpenInApplication[] | undefined
): string | null {
  const saved = savedApplications ?? []
  const builtIns: Record<string, string> = BUILT_IN_EDITOR_COMMANDS
  if (typeof request.openInApplicationId === 'string') {
    return saved.find((app) => app.id === request.openInApplicationId)?.command ?? null
  }
  if (typeof request.builtInEditorId === 'string') {
    return Object.hasOwn(builtIns, request.builtInEditorId)
      ? builtIns[request.builtInEditorId]
      : null
  }
  if (request.command !== undefined && typeof request.command !== 'string') {
    return null
  }
  const command = request.command?.trim()
  if (!command) {
    return BUILT_IN_EDITOR_COMMANDS.vscode
  }
  // Older renderers send the command itself; honor it only when it is already known.
  const known =
    saved.some((app) => app.command === command) || Object.values(builtIns).includes(command)
  return known ? command : null
}
