import { useCallback, useEffect, useRef, useState } from 'react'
import { canOpenExternalLink, openExternalLink } from '../../platform/external-links/external-link'
import { translate } from '../../i18n/mobile-i18n'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type {
  BrowserPagePromptRequest,
  BrowserStreamedPagePromptKind
} from '../../../../src/shared/browser/prompts/browser-page-prompt'
import { browserPagePromptAnswer } from './mobile-browser-command-operations'

export type MobileBrowserPagePromptRequest = BrowserPagePromptRequest<BrowserStreamedPagePromptKind>

export type MobileBrowserPagePromptState = {
  request: MobileBrowserPagePromptRequest
  pending: boolean
  error?: string
}

type PageEvent = {
  type?: unknown
  request?: MobileBrowserPagePromptRequest
  requestId?: unknown
  download?: { savePath?: unknown; status?: unknown }
}

const PROMPT_KINDS: ReadonlySet<string> = new Set(['site-permission', 'http-auth', 'external-app'])

/** A host page's link the phone may open; never the app's own `orca:` links. */
function phoneCanOpen(url: string | undefined): url is string {
  return url !== undefined && !/^orca:/i.test(url) && canOpenExternalLink(url)
}

function downloadNotice(event: PageEvent): string | null {
  const path = typeof event.download?.savePath === 'string' ? event.download.savePath : ''
  if (event.type === 'downloadRequested' && path) {
    return translate('browser.pagePrompt.downloadStarted', 'Downloading to {{path}} on the host', {
      path
    })
  }
  if (event.type !== 'downloadFinished') {
    return null
  }
  if (event.download?.status === 'completed' && path) {
    return translate('browser.pagePrompt.downloadSaved', 'Saved to {{path}} on the host', { path })
  }
  return event.download?.status === 'canceled'
    ? translate('browser.pagePrompt.downloadCanceled', 'Download canceled.')
    : translate('browser.pagePrompt.downloadFailed', "Couldn't finish the download.")
}

/** The streamed page's permission, sign-in and open-app prompts, and where its downloads land. */
export function useMobileBrowserPagePrompts(args: {
  client: RpcClient | null
  onToast: (message: string, durationMs?: number) => void
}) {
  const { client, onToast } = args
  const [prompt, setPrompt] = useState<MobileBrowserPagePromptState | null>(null)
  // Read at event time, so the stream that calls handlePageEvent never restarts for a new toast callback.
  const onToastRef = useRef(onToast)
  useEffect(() => {
    onToastRef.current = onToast
  }, [onToast])

  /** True when the event was one of this hook's. */
  const handlePageEvent = useCallback((payload: unknown): boolean => {
    if (typeof payload !== 'object' || payload === null) {
      return false
    }
    const event: PageEvent = payload
    if (event.type === 'pagePrompt' && event.request && PROMPT_KINDS.has(event.request.kind)) {
      const request = event.request
      // The host replays prompts it still holds to a returning stream.
      setPrompt((current) =>
        current?.request.requestId === request.requestId ? current : { request, pending: false }
      )
      return true
    }
    if (event.type === 'pagePromptClosed') {
      setPrompt((current) => (current?.request.requestId === event.requestId ? null : current))
      return true
    }
    // An ended stream no longer hears the close or may answer; the next stream gets it replayed.
    if (event.type === 'end' || event.type === 'error') {
      setPrompt(null)
      return false
    }
    const notice = downloadNotice(event)
    if (notice) {
      onToastRef.current(notice)
    }
    return notice !== null
  }, [])

  const answer = useCallback(
    async (choice: unknown): Promise<void> => {
      const current = prompt
      if (!client || !current) {
        return
      }
      const { request } = current
      const link = request.kind === 'external-app' && choice ? request.details.url : undefined
      // A link this phone can't open is declined, so the page isn't told it opened.
      const opensHere = link === undefined || phoneCanOpen(link)
      const value = opensHere ? choice : null
      setPrompt((open) =>
        open === current ? { ...current, pending: true, error: undefined } : open
      )
      let answered = false
      try {
        const reply = browserPagePromptAnswer.interpret(
          await browserPagePromptAnswer.request(
            client,
            { requestId: request.requestId, answer: value },
            { timeoutMs: 15_000 }
          )
        )
        answered = reply.result === 'answered'
      } catch {
        answered = false
      }
      // A refused decline would trap the pane under the card; the host times it out anyway.
      if (!answered && value !== null && value !== 'block') {
        setPrompt((open) =>
          open?.request.requestId === request.requestId
            ? {
                ...open,
                pending: false,
                error: translate(
                  'browser.pagePrompt.answerFailed',
                  'That answer did not reach the page.'
                )
              }
            : open
        )
        return
      }
      setPrompt((open) => (open?.request.requestId === request.requestId ? null : open))
      if (request.kind !== 'external-app' || !choice) {
        return
      }
      // A streamed page's link opens here, never on the host.
      if (link !== undefined && opensHere && answered) {
        openExternalLink(link)
      } else if (!opensHere) {
        onToastRef.current(
          translate(
            'browser.pagePrompt.openFailed',
            "Couldn't open an app for this {{scheme}} link.",
            { scheme: request.details.scheme }
          )
        )
      }
    },
    [client, prompt]
  )

  const clearPrompt = useCallback(() => setPrompt(null), [])
  return { prompt, answer, handlePageEvent, clearPrompt }
}
