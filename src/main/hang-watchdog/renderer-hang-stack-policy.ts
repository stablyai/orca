import type { WebContents, Session } from 'electron'
import { resolveObservabilityConsent } from '../observability'

const owners = new WeakMap<Session, Map<number, string>>()

export function installRendererHangStackPolicy(contents: WebContents, documentUrl: string): void {
  try {
    installPolicy(contents, documentUrl)
  } catch {
    // A rejected diagnostic policy must not prevent the main document from loading.
  }
}

function installPolicy(contents: WebContents, documentUrl: string): void {
  if (!resolveObservabilityConsent().localFileEnabled) {
    return
  }
  const session = contents.session
  let documents = owners.get(session)
  if (!documents) {
    documents = new Map()
    const owned = documents
    // The default session has one header owner; browser profile sessions use their own policy.
    session.webRequest.onHeadersReceived(
      { urls: [documentUrl], types: ['mainFrame'] },
      (details, callback) => {
        if (
          !resolveObservabilityConsent().localFileEnabled ||
          details.resourceType !== 'mainFrame' ||
          details.webContentsId === undefined ||
          owned.get(details.webContentsId) !== details.url
        ) {
          callback({})
          return
        }
        const headers = { ...details.responseHeaders }
        const key =
          Object.keys(headers).find((name) => name.toLowerCase() === 'document-policy') ??
          'Document-Policy'
        headers[key] = [
          ...(headers[key] ?? [])
            .flatMap((value) => value.split(','))
            .filter(
              (value) => !/^\s*include-js-call-stacks-in-crash-reports(?:\s|=|$)/.test(value)
            ),
          'include-js-call-stacks-in-crash-reports'
        ]
        callback({ responseHeaders: headers })
      }
    )
    owners.set(session, documents)
  }
  if (!documents.has(contents.id)) {
    const id = contents.id
    contents.on('destroyed', () => documents?.delete(id))
  }
  documents.set(contents.id, documentUrl)
}
