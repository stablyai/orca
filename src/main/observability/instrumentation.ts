// Convenience wrappers around the tracer for the span boundaries listed in
// telemetry-error-tracking.md §"Span boundaries worth capturing":
//
//   - IPC boundaries (renderer → main preload calls)
//   - Agent session lifecycle (start, turn, stop, recover)
//   - Git command execution
//   - Worktree setup (clone / checkout / install)
//   - PTY session lifecycle
//   - External editor launches
//   - Updater operations
//
// Each helper wraps `withSpan` from `tracer.ts` with a sensible default
// span name and a small attribute pack. Call sites that already produce
// detailed Result objects (git runner returning stdout/stderr; PTY layer
// reporting exit codes) thread that detail in via `attributes` so the
// span attribute pack stays cohesive without each call site re-inventing
// keys.
//
// All helpers are no-ops when the tracer's active sink is unset (the
// observability lane was disabled at startup by env var or CI). The span
// itself becomes a `noopSpan` that swallows all calls — call sites do not
// need to branch on whether tracing is on.

import { withSpan, type ActiveSpan } from './tracer'

export type GitSpanArgs = {
  readonly args: readonly string[]
  readonly cwd?: string
}

/** Wrap a git execution in a `git.exec` span. The first argument typically
 *  is the subcommand (`status`, `clone`, `pull`); promoting it to its own
 *  attribute makes it grep-friendly without pulling the full args array
 *  into a single comma-joined string in dashboards. */
export async function withGitSpan<T>(meta: GitSpanArgs, fn: () => Promise<T>): Promise<T> {
  return withSpan(
    'git.exec',
    async (span) => {
      span.setAttribute('git.subcommand', meta.args[0] ?? '<none>')
      // Why: git args can contain commit messages, branch names, remotes, or
      // paths. Keep cardinality without copying user-authored content.
      span.setAttribute('git.arg_count', meta.args.length)
      if (meta.cwd) {
        span.setAttribute('cwd', meta.cwd)
      }
      return await fn()
    },
    { attributes: { kind: 'git' } }
  )
}

export type IpcSpanArgs = {
  readonly channel: string
}

/** Wrap an ipcMain handler invocation in an `ipc.handle` span. Used by
 *  the highest-traffic handlers — `git`, `runtime`, `pty`, `worktree`,
 *  `agent` — not every handler. Tracing every IPC call would explode the
 *  trace tree and obscure the spans that matter. */
export async function withIpcSpan<T>(meta: IpcSpanArgs, fn: () => Promise<T> | T): Promise<T> {
  return withSpan(
    'ipc.handle',
    async (span) => {
      span.setAttribute('ipc.channel', meta.channel)
      return await fn()
    },
    { attributes: { kind: 'ipc' } }
  )
}

export type WorktreeSpanArgs = {
  readonly stage: 'clone' | 'checkout' | 'install' | 'create' | 'remove'
  readonly path?: string
}

/** Wrap a worktree-setup phase in a `worktree.<stage>` span. */
export async function withWorktreeSpan<T>(
  meta: WorktreeSpanArgs,
  fn: () => Promise<T>
): Promise<T> {
  return withSpan(
    `worktree.${meta.stage}`,
    async (span) => {
      span.setAttribute('worktree.stage', meta.stage)
      if (meta.path) {
        span.setAttribute('worktree.path', meta.path)
      }
      return await fn()
    },
    { attributes: { kind: 'worktree' } }
  )
}

export type PtySpanArgs = {
  readonly stage: 'spawn' | 'exit' | 'recover'
  readonly shell?: string
  readonly cwd?: string
}

/** Wrap a PTY-lifecycle event in a `pty.<stage>` span. The lifecycle is
 *  long-lived; callers typically use `startSpan` directly for the live
 *  session and call `withPtySpan` only for the spawn/exit moments. */
export async function withPtySpan<T>(meta: PtySpanArgs, fn: () => Promise<T> | T): Promise<T> {
  return withSpan(
    `pty.${meta.stage}`,
    async (span) => {
      span.setAttribute('pty.stage', meta.stage)
      if (meta.shell) {
        span.setAttribute('pty.shell', meta.shell)
      }
      if (meta.cwd) {
        span.setAttribute('cwd', meta.cwd)
      }
      return await fn()
    },
    { attributes: { kind: 'pty' } }
  )
}

export type AgentSpanArgs = {
  readonly stage: 'start' | 'turn' | 'stop' | 'recover'
  readonly agentKind?: string
}

export async function withAgentSpan<T>(meta: AgentSpanArgs, fn: () => Promise<T> | T): Promise<T> {
  return withSpan(
    `agent.${meta.stage}`,
    async (span) => {
      span.setAttribute('agent.stage', meta.stage)
      if (meta.agentKind) {
        span.setAttribute('agent.kind', meta.agentKind)
      }
      return await fn()
    },
    { attributes: { kind: 'agent' } }
  )
}

export type ExternalEditorSpanArgs = {
  readonly editor: string
  readonly path?: string
}

export async function withExternalEditorSpan<T>(
  meta: ExternalEditorSpanArgs,
  fn: () => Promise<T> | T
): Promise<T> {
  return withSpan(
    'external_editor.launch',
    async (span) => {
      span.setAttribute('editor', meta.editor)
      if (meta.path) {
        span.setAttribute('path', meta.path)
      }
      return await fn()
    },
    { attributes: { kind: 'external_editor' } }
  )
}

export type UpdaterSpanArgs = {
  readonly stage: 'check' | 'download' | 'install'
}

export async function withUpdaterSpan<T>(
  meta: UpdaterSpanArgs,
  fn: (span: ActiveSpan) => Promise<T> | T
): Promise<T> {
  return withSpan(
    `updater.${meta.stage}`,
    async (span) => {
      span.setAttribute('updater.stage', meta.stage)
      return await fn(span)
    },
    { attributes: { kind: 'updater' } }
  )
}
