// Pure clangd-protocol pieces of the session: initialize parameter shape,
// server-request answers, the $/progress -> status reducer and result
// mapping. Kept free of process/transport concerns so they stay unit-testable
// and the session module stays under its line budget.
import type {
  LanguageServerDefinitionLocation,
  LanguageServerHoverContent
} from '../../shared/language-server-navigation-types'
import { nativePathToLspUri } from './uri-mapping'

/** The initialize params verified against clangd 23 in the spike (findings §5). */
export function buildClangdInitializeParams(rootPath: string, processId: number): unknown {
  const rootUri = nativePathToLspUri(rootPath)
  const rootName = rootPath.split(/[\\/]/).pop() ?? rootPath
  return {
    processId,
    clientInfo: { name: 'orca', version: 'editor-navigation' },
    rootUri,
    workspaceFolders: [{ uri: rootUri, name: rootName }],
    capabilities: {
      // clangd defaults to UTF-8 offsets unless negotiated otherwise, while
      // Monaco columns are UTF-16 code units — pin the shared basis (§1).
      general: { positionEncodings: ['utf-16'] },
      window: { workDoneProgress: true },
      workspace: { workspaceFolders: false, configuration: false },
      textDocument: {
        synchronization: {
          dynamicRegistration: false,
          willSave: false,
          willSaveWaitUntil: false,
          didSave: false
        },
        hover: { dynamicRegistration: false, contentFormat: ['markdown', 'plaintext'] },
        definition: { dynamicRegistration: false, linkSupport: false },
        declaration: { dynamicRegistration: false, linkSupport: false },
        references: { dynamicRegistration: false }
      }
    }
  }
}

/**
 * Server->client request answers. These MUST be answered or clangd stalls
 * (spike findings §5): workDoneProgress/create gates every $/progress
 * notification, workspace/configuration expects one result per item.
 */
export function answerClangdServerRequest(
  method: string,
  params: unknown,
  log: (line: string) => void
): unknown {
  if (method === 'workspace/configuration') {
    // No clangd config file support in v1: answer null per item.
    const items = (params as { items?: unknown[] } | null)?.items ?? []
    return items.map(() => null)
  }
  if (method === 'window/workDoneProgress/create') {
    return null
  }
  log(`[clangd] server request ${method} -> null`)
  return null
}

export type ClangdProgressTracker = {
  /** Projected status text, null to clear, undefined when the event carries no projection. */
  reduce(params: unknown): string | null | undefined
}

/** Maps `$/progress` notifications to a single status-line projection. */
export function createClangdProgressTracker(): ClangdProgressTracker {
  // token -> title, so reports after `begin` stay named.
  const titles = new Map<string | number, string>()
  return {
    reduce(params: unknown): string | null | undefined {
      const p = params as {
        token?: string | number
        value?: { kind?: string; title?: string; message?: string; percentage?: number }
      } | null
      const token = p?.token
      if (token === undefined) {
        return undefined
      }
      const value = p?.value
      if (value?.kind === 'begin' && value.title) {
        titles.set(token, value.title)
      }
      if (value?.kind === 'end') {
        titles.delete(token)
        return titles.size > 0 ? 'clangd working' : null
      }
      const title = titles.get(token) ?? 'clangd'
      const pct = typeof value?.percentage === 'number' ? ` ${Math.floor(value.percentage)}%` : ''
      const detail = value?.message ? ` — ${value.message}` : ''
      return `clangd: ${title}${pct}${detail}`
    }
  }
}

type RawLocation = {
  uri?: string
  range?: {
    start?: { line: number; character: number }
    end?: { line: number; character: number }
  }
} | null

/** LSP definition result (single | array | null) -> semantic locations. */
export function mapClangdDefinitionResult(
  result: unknown,
  lspUriToPath: (uri: string) => string
): LanguageServerDefinitionLocation[] {
  const raw = Array.isArray(result) ? result : result ? [result] : []
  const locations: LanguageServerDefinitionLocation[] = []
  for (const item of raw as RawLocation[]) {
    if (!item?.uri || !item.range?.start || !item.range.end) {
      continue
    }
    locations.push({
      path: lspUriToPath(item.uri),
      range: {
        startLine: item.range.start.line,
        startCharacter: item.range.start.character,
        endLine: item.range.end.line,
        endCharacter: item.range.end.character
      }
    })
  }
  return locations
}

/** LSP hover result (all legal content shapes) -> semantic hover or null. */
export function mapClangdHoverResult(result: unknown): LanguageServerHoverContent | null {
  const contents = (result as { contents?: unknown } | null)?.contents
  if (typeof contents === 'string') {
    return { kind: 'plaintext', value: contents }
  }
  if (Array.isArray(contents)) {
    const value = contents
      .map((entry) =>
        typeof entry === 'string' ? entry : String((entry as { value?: string })?.value ?? '')
      )
      .filter(Boolean)
      .join('\n\n')
    return value ? { kind: 'plaintext', value } : null
  }
  const markup = contents as { kind?: string; value?: string } | null
  if (!markup?.value) {
    return null
  }
  return { kind: markup.kind === 'plaintext' ? 'plaintext' : 'markdown', value: markup.value }
}
