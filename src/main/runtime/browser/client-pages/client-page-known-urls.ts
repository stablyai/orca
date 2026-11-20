// Where a client-hosted page may be, as this host knows it: the page record, which an unwatched
// client pane stops updating, and the address each agent command last reported from the client.
import { isRecord } from '../../../../shared/agent-status/child-work/agent-status-child-work-value-guards'
import type { RuntimeBrowserPageRegistry } from './runtime-browser-page-registry'

const reportedUrls = new Map<string, string>()
const MAX_REPORTED_URLS = 512

/** Records the address an agent command's result names: a goto's `url`, or its effects' new one. */
export function rememberClientPageReportedUrl(browserPageId: string, result: unknown): void {
  const url = !isRecord(result)
    ? undefined
    : typeof result.url === 'string'
      ? result.url
      : isRecord(result.effects) && typeof result.effects.url === 'string'
        ? result.effects.url
        : undefined
  if (url === undefined) {
    return
  }
  reportedUrls.delete(browserPageId)
  reportedUrls.set(browserPageId, url)
  if (reportedUrls.size > MAX_REPORTED_URLS) {
    reportedUrls.delete(reportedUrls.keys().next().value!)
  }
}

export function clientPageKnownUrls(
  pages: Pick<RuntimeBrowserPageRegistry, 'getPage'>,
  browserPageId: string
): string[] {
  const urls = [pages.getPage(browserPageId)?.url, reportedUrls.get(browserPageId)]
  return urls.filter((url): url is string => url !== undefined)
}
