import { dialog, shell } from 'electron'
import { classifyExternalAppUrl } from '../shared/external-app-url'

export type OpenExternalAppUrlResult = 'opened' | 'cancelled' | 'denied' | 'invalid' | 'failed'

// Why: will-navigate + window.open can fire many custom schemes at once; serialize
// confirm dialogs so a hostile page cannot stack unbounded MessageBoxes (#12719).
let customSchemePromptTail: Promise<unknown> = Promise.resolve()

/**
 * Open a custom app-scheme URL after an explicit user confirm dialog.
 * http(s) open without prompt (caller should use normal paths for those).
 */
export async function openExternalAppUrlWithUserApproval(
  rawUrl: string,
  options: { requestingOrigin?: string } = {}
): Promise<OpenExternalAppUrlResult> {
  const classified = classifyExternalAppUrl(rawUrl)
  if (!classified.ok) {
    return classified.reason === 'denied' ? 'denied' : 'invalid'
  }
  if (classified.kind === 'http') {
    try {
      await shell.openExternal(classified.url)
      return 'opened'
    } catch {
      return 'failed'
    }
  }

  const runPrompt = async (): Promise<OpenExternalAppUrlResult> => {
    const originLine = options.requestingOrigin?.trim()
      ? `\n\nRequested by: ${options.requestingOrigin.trim()}`
      : ''
    const prompt = await dialog.showMessageBox({
      type: 'question',
      buttons: ['Open', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Open external app link?',
      message: `Open this ${classified.schemeLabel} link in the registered app?`,
      detail: `${classified.url}${originLine}`,
      noLink: true
    })
    if (prompt.response !== 0) {
      return 'cancelled'
    }
    try {
      await shell.openExternal(classified.url)
      return 'opened'
    } catch {
      return 'failed'
    }
  }

  const resultPromise = customSchemePromptTail.then(runPrompt, runPrompt)
  customSchemePromptTail = resultPromise.then(
    () => undefined,
    () => undefined
  )
  return resultPromise
}
