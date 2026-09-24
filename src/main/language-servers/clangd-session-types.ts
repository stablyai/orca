// Pure type declarations for the clangd session, split out so the session
// module stays under its line budget (mirrors language-server-host-types.ts).
import type { spawnProcess } from '../../shared/child-process/run-process'
import type {
  LanguageServerDefinitionLocation,
  LanguageServerDocumentChange,
  LanguageServerHoverContent,
  LanguageServerPosition,
  LanguageServerSemanticTokens
} from '../../shared/language-server-navigation-types'

export type ClangdSessionOptions = {
  program: string
  args: readonly string[]
  /** Worktree root in native path form; session cwd + rootUri. */
  rootPath: string
  /** `$/progress` projection for the status line; null clears it. */
  onStatus?: (text: string | null) => void
  onLog?: (line: string) => void
  /** Fired once when the session ends for any reason (crash or stop). */
  onExit?: (error: Error | null) => void
  spawnImpl?: typeof spawnProcess
}

export type ClangdSession = {
  readonly serverVersion: string | null
  readonly rootPath: string
  readonly died: Error | null
  hasDocument(filePath: string): boolean
  didOpen(filePath: string, text: string): void
  /** Returns the version actually sent after the monotonic clamp. */
  didChange(
    filePath: string,
    version: number,
    changes: readonly LanguageServerDocumentChange[]
  ): number
  didClose(filePath: string): void
  definition(
    filePath: string,
    position: LanguageServerPosition
  ): Promise<LanguageServerDefinitionLocation[]>
  references(
    filePath: string,
    position: LanguageServerPosition
  ): Promise<LanguageServerDefinitionLocation[]>
  declaration(
    filePath: string,
    position: LanguageServerPosition
  ): Promise<LanguageServerDefinitionLocation[]>
  hover(
    filePath: string,
    position: LanguageServerPosition
  ): Promise<LanguageServerHoverContent | null>
  /** textDocument/semanticTokens/full, decoded BY NAME against the server legend. */
  semanticTokensFull(filePath: string): Promise<LanguageServerSemanticTokens>
  /** shutdown -> exit -> 5s grace -> tree kill (spec D8). */
  stop(): Promise<void>
}
