import type { TuiRpcClient } from './tui-rpc-client'

/** Identifies the TUI as the sender for terminal.send. The runtime only accepts
 *  a 'mobile' | 'desktop' client type on input writes; the CLI is desktop-class. */
const TUI_CLIENT = { id: 'orca-tui', type: 'desktop' as const }

/** A worktree selector string the runtime understands (`id:<worktreeId>`). */
export function worktreeSelector(worktreeId: string): string {
  return `id:${worktreeId}`
}

/** A concrete, fully-specified worktree command. Building these is kept separate
 *  from triggering keys so param construction is unit-testable. */
export type TuiCommand =
  | { kind: 'worktree.create'; repo: string; name: string; agent?: string; prompt?: string }
  | { kind: 'worktree.rm'; worktree: string; force?: boolean }
  | { kind: 'worktree.activate'; worktree: string }
  | { kind: 'worktree.sleep'; worktree: string }
  | { kind: 'worktree.set'; worktree: string; displayName: string }
  | { kind: 'terminal.create'; worktree: string; command?: string; title?: string }
  | { kind: 'terminal.send'; terminal: string; text?: string; enter?: boolean; interrupt?: boolean }
  | { kind: 'terminal.split'; terminal: string; direction?: 'horizontal' | 'vertical' }
  | { kind: 'terminal.close'; terminal: string }
  | { kind: 'session.tabs.close'; worktree: string; tabId: string }
  | { kind: 'terminal.rename'; terminal: string; title: string | null }
  | { kind: 'terminal.stop'; worktree: string }
  | { kind: 'terminal.focus'; terminal: string }
  | { kind: 'orchestration.send'; from: string; to: string; subject: string; body?: string }
  | { kind: 'orchestration.reply'; id: string; from: string; body: string }

export type RpcCall = { method: string; params: Record<string, unknown> }

/** Commands that destroy or interrupt state and therefore require a confirm
 *  step before dispatch. */
const DESTRUCTIVE_KINDS = new Set<TuiCommand['kind']>([
  'worktree.rm',
  'terminal.close',
  'session.tabs.close',
  'terminal.stop'
])

export function isDestructive(command: TuiCommand): boolean {
  return DESTRUCTIVE_KINDS.has(command.kind)
}

/** Translate a command into the runtime RPC method + params. Always passes an
 *  explicit worktree/terminal selector (never relies on cwd), which is required
 *  for remote runtimes where cwd can't identify a server-side worktree. */
export function buildCall(command: TuiCommand): RpcCall {
  switch (command.kind) {
    case 'worktree.create':
      return {
        method: 'worktree.create',
        params: {
          repo: command.repo,
          name: command.name,
          // The runtime expects startupAgent/startupPrompt; plain agent/prompt
          // are silently dropped and the agent never launches.
          startupAgent: command.agent,
          startupPrompt: command.prompt
        }
      }
    case 'worktree.rm':
      return { method: 'worktree.rm', params: { worktree: command.worktree, force: command.force } }
    case 'worktree.activate':
      return { method: 'worktree.activate', params: { worktree: command.worktree } }
    case 'worktree.sleep':
      return { method: 'worktree.sleep', params: { worktree: command.worktree } }
    case 'worktree.set':
      return {
        method: 'worktree.set',
        params: { worktree: command.worktree, displayName: command.displayName }
      }
    case 'terminal.create':
      return {
        method: 'terminal.create',
        params: { worktree: command.worktree, command: command.command, title: command.title }
      }
    case 'terminal.send':
      return {
        method: 'terminal.send',
        params: {
          terminal: command.terminal,
          text: command.text,
          enter: command.enter,
          interrupt: command.interrupt,
          client: TUI_CLIENT
        }
      }
    case 'terminal.split':
      return {
        method: 'terminal.split',
        params: { terminal: command.terminal, direction: command.direction }
      }
    case 'terminal.close':
      return { method: 'terminal.close', params: { terminal: command.terminal } }
    case 'session.tabs.close':
      return {
        method: 'session.tabs.close',
        params: { worktree: command.worktree, tabId: command.tabId }
      }
    case 'terminal.rename':
      return {
        method: 'terminal.rename',
        params: { terminal: command.terminal, title: command.title }
      }
    case 'terminal.stop':
      return { method: 'terminal.stop', params: { worktree: command.worktree } }
    case 'terminal.focus':
      return { method: 'terminal.focus', params: { terminal: command.terminal } }
    case 'orchestration.send':
      return {
        method: 'orchestration.send',
        params: {
          from: command.from,
          to: command.to,
          subject: command.subject,
          body: command.body
        }
      }
    case 'orchestration.reply':
      return {
        method: 'orchestration.reply',
        params: { id: command.id, from: command.from, body: command.body }
      }
  }
}

/** Forward raw keystroke bytes to a focused terminal. Best-effort and silent:
 *  it runs on every keypress, so (unlike dispatchAction) it neither surfaces
 *  errors nor refreshes the worktree snapshot. */
export async function sendTerminalKeys(
  client: TuiRpcClient,
  terminal: string,
  data: string
): Promise<void> {
  try {
    await client.call('terminal.send', { terminal, text: data, client: TUI_CLIENT })
  } catch {
    // A dropped keystroke is recoverable; the next poll re-syncs the screen.
  }
}

export type DispatchResult = { ok: true } | { ok: false; error: string }

/** Execute a command. Errors are returned (not thrown) so the app can surface
 *  them inline and keep the render loop alive. */
export async function dispatchAction(
  client: TuiRpcClient,
  command: TuiCommand
): Promise<DispatchResult> {
  const { method, params } = buildCall(command)
  try {
    await client.call(method, params)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
