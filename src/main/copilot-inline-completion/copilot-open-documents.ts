import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { CopilotOpenDocumentArgs } from '../../shared/copilot-inline-completion-types'
import type { CopilotServerConnection } from './copilot-server-connection'
import { toCopilotDocumentLanguageId } from './copilot-protocol'

type OpenDocumentState = { version: number; refCount: number }

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
  function open(connection: CopilotServerConnection, args: CopilotOpenDocumentArgs): string {
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
      existing.refCount++
      // Why: a second surface can open the same file with different text; last writer wins.
      sendDidChange(connection, fileUri, existing, args.text)
    } else {
      documents.set(fileUri, { version: 1, refCount: 1 })
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

  function change(connection: CopilotServerConnection, fileUri: string, text: string): void {
    const document = documents.get(fileUri)
    if (document) {
      sendDidChange(connection, fileUri, document, text)
    }
  }

  /** Drops one reference; returns true when the last one went and didClose was sent. */
  function close(connection: CopilotServerConnection, fileUri: string): boolean {
    const document = documents.get(fileUri)
    if (!document || --document.refCount > 0) {
      return false
    }
    documents.delete(fileUri)
    connection.notify('textDocument/didClose', { textDocument: { uri: fileUri } })
    return true
  }

  return {
    open,
    change,
    close,
    versionOf: (fileUri: string): number | null => documents.get(fileUri)?.version ?? null,
    count: (): number => documents.size,
    clear: (): void => {
      documents.clear()
      workspaceRoots.clear()
    }
  }
}
