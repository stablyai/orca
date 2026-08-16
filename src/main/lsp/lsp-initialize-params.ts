import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Client capabilities for Orca's LSP bridge: hover, definition, completion,
 *  push + pull diagnostics, full-text sync. Advertising `diagnostic` lets
 *  pull-model servers (tsgo/TS7) expose their diagnosticProvider. */
export function buildLspInitializeParams(rootPath: string): object {
  const rootUri = pathToFileURL(rootPath).toString()
  return {
    processId: process.pid,
    rootUri,
    workspaceFolders: [{ uri: rootUri, name: basename(rootPath) }],
    capabilities: {
      textDocument: {
        hover: { contentFormat: ['markdown', 'plaintext'] },
        definition: {},
        references: {},
        completion: {
          completionItem: { snippetSupport: false, documentationFormat: ['markdown', 'plaintext'] }
        },
        publishDiagnostics: {},
        diagnostic: {},
        synchronization: { didSave: false }
      },
      workspace: { workspaceFolders: true }
    }
  }
}
