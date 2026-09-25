// Types + constants for the language-server host, split out so the host module
// stays under its line budget. The host implementation (session management,
// idle timer, LRU cap) lives in language-server-host.ts.
import type { ClangdSession } from './clangd-session'
import type { ClangdVersionGateResult } from './clangd-launch'
import type { CompileDbStrategy } from './compile-db/compile-db-strategy-types'
export type { CompileDbStrategy } from './compile-db/compile-db-strategy-types'
import type {
  LanguageServerDefinitionLocation,
  LanguageServerDocumentChange,
  LanguageServerHoverContent,
  LanguageServerPosition,
  LanguageServerSemanticTokens
} from '../../shared/language-server-navigation-types'

/** 10min idle -> graceful shutdown (spec §6). */
export const LANGUAGE_SERVER_IDLE_TIMEOUT_MS = 10 * 60 * 1000
/** Concurrent sessions above this trigger LRU eviction (spec §6). */
export const LANGUAGE_SERVER_MAX_CONCURRENT_SESSIONS = 3

export type LanguageServerHostEvents = {
  /** `$/progress` projection; null clears the status line. */
  onStatus?: (text: string | null) => void
  /** One-shot notifications the renderer surfaces as a toast (LRU eviction). */
  onToast?: (message: string) => void
  /** Persistent degraded-state hint (version too low / no clangd); null clears. */
  onDegraded?: (message: string | null) => void
  onLog?: (line: string) => void
}

/** A probe that classifies the resolved clangd binary; injected for tests. */
export type ClangdVersionGate = (program: string) => Promise<ClangdVersionGateResult>

/** Factory for the per-worktree compile-db strategy; injected for tests. */
export type CompileDbStrategyFactory = (
  worktreeRoot: string,
  hooks: CompileDbStrategyHooks
) => CompileDbStrategy

import type { LanguageServerHostAdapter } from './language-server-host-adapter'

/** Test-seam type for host-adapter selection that can route SSH worktrees. */
export type HostAdapterSelector = (
  worktreeRoot: string,
  sshTargetId: string | null
) => LanguageServerHostAdapter

/** Hooks the db strategy routes degraded/toast/status through (mirror host events). */
export type CompileDbStrategyHooks = {
  onStatus?: (text: string | null) => void
  onDegraded?: (message: string | null) => void
  onToast?: (message: string) => void
  onLog?: (line: string) => void
}

export type LanguageServerHost = {
  openDocument(args: {
    worktreeRoot: string
    filePath: string
    text: string
    /** SSH target id when the worktree is on a remote host (ticket 17);
     *  null/undefined for local + WSL. Routes clangd through the relay lsp.* channel. */
    connectionId?: string | null
  }): Promise<{ ok: true } | { ok: false; error: string }>
  changeDocument(args: {
    filePath: string
    version: number
    changes: readonly LanguageServerDocumentChange[]
  }): { ok: true; version: number } | { ok: false; error: string }
  closeDocument(args: { filePath: string }): { ok: true } | { ok: false; error: string }
  definition(args: {
    filePath: string
    position: LanguageServerPosition
  }): Promise<LanguageServerDefinitionLocation[]>
  references(args: {
    filePath: string
    position: LanguageServerPosition
  }): Promise<LanguageServerDefinitionLocation[]>
  declaration(args: {
    filePath: string
    position: LanguageServerPosition
  }): Promise<LanguageServerDefinitionLocation[]>
  hover(args: {
    filePath: string
    position: LanguageServerPosition
  }): Promise<LanguageServerHoverContent | null>
  semanticTokens(args: { filePath: string }): Promise<LanguageServerSemanticTokens>
  /** shutdown -> exit for every live session (app quit path). */
  shutdownAll(): Promise<void>
  /** Test seam: live session count. */
  readonly sessionCount: number
}

export type SessionEntry = {
  key: string
  session: ClangdSession | null
  startPromise: Promise<ClangdSession> | null
  /** Open C/C++ documents served by this session (worktree-relative or external). */
  openDocuments: Set<string>
  /** Open-document texts, retained so a respawn after a died session can replay didOpen (spec §6). */
  openDocumentTexts: Map<string, string>
  /** Last-activity wall clock for LRU ordering; bumped on open/change. */
  lastActivityMs: number
  /** Armed idle-shutdown timer; cancelled on re-open. */
  idleTimer: ReturnType<typeof setTimeout> | null
  /** Version-gate verdict cached so a reject doesn't re-probe every didOpen. */
  gate: ClangdVersionGateResult | null
  /** Compile-db strategy for this worktree; disposed on session drop. */
  dbStrategy: CompileDbStrategy | null
}
