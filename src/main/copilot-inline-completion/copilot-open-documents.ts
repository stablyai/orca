import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { CopilotOpenDocumentArgs } from '../../shared/copilot-inline-completion-types'
import type { CopilotServerConnection } from './copilot-server-connection'
import { toCopilotDocumentLanguageId } from './copilot-protocol'

type OpenDocumentState = { version: number; owners: Map<AbortSignal, number> }

/** Documents and workspace roots announced to one Copilot server process. */
export function createCopilotOpenDocuments() {
  const documents = new Map<string, OpenDocumentState>()
  const workspaceRoots = new Set<string>()

  function sendDidChange(
    connection: CopilotServerConnection,
    fileUri: string,
    document: OpenDocumentState,
    text: string
  ): void {
    document.version++
    connection.notify('textDocument/didChange', {
      textDocument: { uri: fileUri, version: document.version },
      contentChanges: [{ text }]
    })
  }

  /** Registers (or re-references) the document and returns its file URI. */
  function open(
    connection: CopilotServerConnection,
    args: CopilotOpenDocumentArgs,
    owner: AbortSignal
  ): string {
    const rootUri = pathToFileURL(args.rootPath).toString()
    if (!workspaceRoots.has(rootUri)) {
      workspaceRoots.add(rootUri)
      connection.notify('workspace/didChangeWorkspaceFolders', {
        event: { added: [{ uri: rootUri, name: basename(args.rootPath) }], removed: [] }
      })
    }
    const fileUri = pathToFileURL(args.filePath).toString()
    const existing = documents.get(fileUri)
    if (existing) {
      existing.owners.set(owner, (existing.owners.get(owner) ?? 0) + 1)
      // Why: a second surface can open the same file with different text; last writer wins.
      sendDidChange(connection, fileUri, existing, args.text)
    } else {
      documents.set(fileUri, { version: 1, owners: new Map([[owner, 1]]) })
      connection.notify('textDocument/didOpen', {
        textDocument: {
          uri: fileUri,
          languageId: toCopilotDocumentLanguageId(args.languageId, args.filePath),
          version: 1,
          text: args.text
        }
      })
    }
    return fileUri
  }

  function change(
    connection: CopilotServerConnection,
    fileUri: string,
    text: string,
    owner: AbortSignal
  ): void {
    const document = documents.get(fileUri)
    if (document?.owners.has(owner)) {
      sendDidChange(connection, fileUri, document, text)
    }
  }

  function close(
    connection: CopilotServerConnection,
    fileUri: string,
    owner: AbortSignal,
    all = false
  ): boolean {
    const document = documents.get(fileUri)
    const count = document?.owners.get(owner)
    if (!document || !count) {
      return false
    }
    if (!all && count > 1) {
      document.owners.set(owner, count - 1)
      return false
    }
    document.owners.delete(owner)
    if (document.owners.size > 0) {
      return false
    }
    documents.delete(fileUri)
    connection.notify('textDocument/didClose', { textDocument: { uri: fileUri } })
    return true
  }

  function releaseOwner(connection: CopilotServerConnection, owner: AbortSignal): void {
    for (const fileUri of documents.keys()) {
      close(connection, fileUri, owner, true)
    }
  }

  return {
    open,
    change,
    close,
    releaseOwner,
    versionOf(fileUri: string, owner: AbortSignal): number | null {
      const document = documents.get(fileUri)
      return document?.owners.has(owner) ? document.version : null
    },
    count: (): number => documents.size,
    clear: (): void => {
      documents.clear()
      workspaceRoots.clear()
    }
  }
}
