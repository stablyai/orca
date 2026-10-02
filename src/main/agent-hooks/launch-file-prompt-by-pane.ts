import { opensLikeLaunchFilePointer, type LaunchFile } from '../../shared/launch-prompt-file'

// Why bounded: an entry outlives its launch until newer ones push it out; the rename reads only a
// prompt's opening, and a pane's rename runs within minutes of its launch.
const KEPT_PANES = 50
const KEPT_CHARS = 4_000
const promptByPane = new Map<string, string>()

/**
 * Keeps a launch file's prompt for the pane it launched: the agent's hook reports only the pointer
 * to the file, and Orca shows the prompt instead (`launchPromptShownForPane`).
 */
export function rememberLaunchFilePrompt(
  paneKey: string,
  launchFile: LaunchFile | undefined
): void {
  if (!launchFile) {
    return
  }
  promptByPane.delete(paneKey)
  promptByPane.set(paneKey, launchFile.content.slice(0, KEPT_CHARS))
  for (const oldest of promptByPane.keys()) {
    if (promptByPane.size <= KEPT_PANES) {
      break
    }
    promptByPane.delete(oldest)
  }
}

/** The one place Orca reads a pane's reported prompt or session title: a launch file's pointer,
 *  whole or cut short, reads as the prompt it points at, when this host kept it. */
export function launchPromptShownForPane(paneKey: string, prompt: string): string {
  return opensLikeLaunchFilePointer(prompt) ? (promptByPane.get(paneKey) ?? prompt) : prompt
}
