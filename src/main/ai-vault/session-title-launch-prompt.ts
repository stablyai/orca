import type {
  AiVaultSessionTitleRequest,
  AiVaultSessionTitlesResult
} from '../../shared/ai-vault-session-title'
import { launchPromptShownForPane } from '../agent-hooks/launch-file-prompt-by-pane'
import { normalizeTitleText } from './session-scanner-text-normalization'

/**
 * Titles a launch file's session with the prompt it carried. Its transcript opens with Orca's
 * pointer, so the tab label and agent row would otherwise show "The full task is in the file …".
 */
export function showLaunchPromptsInSessionTitles(
  requests: readonly AiVaultSessionTitleRequest[],
  result: AiVaultSessionTitlesResult
): AiVaultSessionTitlesResult {
  const paneBySession = new Map(
    requests.flatMap((request) =>
      request.paneKey ? [[`${request.agent}\0${request.sessionId}`, request.paneKey] as const] : []
    )
  )
  if (paneBySession.size === 0) {
    return result
  }
  return {
    titles: result.titles.map((title) => {
      const paneKey = paneBySession.get(`${title.agent}\0${title.sessionId}`)
      const shown = paneKey ? launchPromptShownForPane(paneKey, title.title) : title.title
      return shown === title.title
        ? title
        : { ...title, title: normalizeTitleText(shown) ?? title.title }
    })
  }
}

/** A request as another host receives it: the pane is this host's to read. */
export function withoutPaneKey(request: AiVaultSessionTitleRequest): AiVaultSessionTitleRequest {
  const { paneKey: _paneKey, ...forwarded } = request
  return forwarded
}
