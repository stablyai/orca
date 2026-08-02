import { createHash } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { resolveStartupShell, tokenizeStartupCommand } from '../../shared/tui-agent-startup-shell'
import { quotePosixShell } from '../../shared/wsl-login-shell-command'
export {
  getControlledSocketPath,
  getControlledSocketRoot,
  getControlledStatePath
} from './codex-controlled-socket-paths'

const SOCKET_READY_TIMEOUT_MS = 10_000
const PROCESS_STOP_TIMEOUT_MS = 5_000

export type CodexControlledSessionLaunch = {
  conversationId: string
  threadId: string
  worktreeSelector: string
  workspaceKind: 'worktree' | 'folder'
  hostKind: 'local' | 'ssh' | 'wsl' | 'relay'
  cwd: string
  codexHome: string
  accountId: string | null
  presentation?: 'background' | 'focused'
  command?: string
  model?: string
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
  approvalPolicy?: 'untrusted' | 'on-request' | 'never'
}

export type ControlledCodexServer = {
  process: ChildProcess
  socketIdentity: { dev: number; ino: number }
}

export type ControlledCodexCommand = {
  executable: string
  prefixArgs: string[]
}

export function resolveControlledCodexCommand(
  command: string | undefined,
  platform: NodeJS.Platform = process.platform
): ControlledCodexCommand {
  const parsed = tokenizeStartupCommand(command?.trim() || 'codex', resolveStartupShell(platform))
  if (!parsed.ok || !parsed.tokens[0]) {
    throw new Error('controlled Codex command is invalid')
  }
  const [executable, ...prefixArgs] = parsed.tokens
  return { executable, prefixArgs }
}

export function buildControlledThreadResumeParams(
  input: CodexControlledSessionLaunch
): Record<string, unknown> {
  return {
    threadId: input.threadId,
    cwd: input.cwd,
    ...(input.model ? { model: input.model } : {}),
    ...(input.sandbox ? { sandbox: input.sandbox } : {}),
    ...(input.approvalPolicy ? { approvalPolicy: input.approvalPolicy } : {}),
    excludeTurns: true
  }
}

export function buildControlledThreadStartParams(
  input: CodexControlledSessionLaunch
): Record<string, unknown> {
  return {
    cwd: input.cwd,
    ...(input.model ? { model: input.model } : {}),
    ...(input.sandbox ? { sandbox: input.sandbox } : {}),
    ...(input.approvalPolicy ? { approvalPolicy: input.approvalPolicy } : {}),
    experimentalRawEvents: false
  }
}

export function buildControlledVisibleResumeCommand(
  input: CodexControlledSessionLaunch,
  socketPath: string,
  command: ControlledCodexCommand = resolveControlledCodexCommand(input.command)
): string {
  const args = ['resume', '--remote', `unix://${socketPath}`]
  if (input.model) {
    args.push('--model', input.model)
  }
  if (input.sandbox) {
    args.push('--sandbox', input.sandbox)
  }
  if (input.approvalPolicy) {
    args.push('--ask-for-approval', input.approvalPolicy)
  }
  args.push('--cd', input.cwd, input.threadId)
  return [command.executable, ...command.prefixArgs, ...args].map(quotePosixShell).join(' ')
}

export function isSameControlledLaunch(
  first: CodexControlledSessionLaunch,
  second: CodexControlledSessionLaunch
): boolean {
  return (
    first.conversationId === second.conversationId &&
    first.threadId === second.threadId &&
    first.worktreeSelector === second.worktreeSelector &&
    first.workspaceKind === second.workspaceKind &&
    first.hostKind === second.hostKind &&
    first.cwd === second.cwd &&
    first.codexHome === second.codexHome &&
    first.accountId === second.accountId &&
    first.presentation === second.presentation &&
    first.command === second.command &&
    first.model === second.model &&
    first.sandbox === second.sandbox &&
    first.approvalPolicy === second.approvalPolicy
  )
}

export function getControlledLaunchFingerprint(input: CodexControlledSessionLaunch): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.conversationId,
        input.threadId,
        input.worktreeSelector,
        input.workspaceKind,
        input.hostKind,
        input.cwd,
        input.codexHome,
        input.accountId,
        input.presentation ?? null,
        input.command ?? null,
        input.model ?? null,
        input.sandbox ?? null,
        input.approvalPolicy ?? null
      ])
    )
    .digest('hex')
}

export async function startControlledCodexServer(
  input: CodexControlledSessionLaunch,
  socketPath: string,
  spawnProcess: typeof spawn = spawn,
  command: ControlledCodexCommand = resolveControlledCodexCommand(input.command),
  hardenSocket: typeof chmodSync = chmodSync
): Promise<ControlledCodexServer> {
  const root = dirname(socketPath)
  const rootExisted = existsSync(root)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const rootStat = lstatSync(root)
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    (process.getuid && rootStat.uid !== process.getuid()) ||
    (rootExisted && (rootStat.mode & 0o077) !== 0)
  ) {
    throw new Error('controlled Codex socket root is not a private owned directory')
  }
  chmodSync(root, 0o700)
  if (existsSync(socketPath)) {
    throw new Error('controlled Codex socket path is already owned')
  }
  const child = spawnProcess(
    command.executable,
    [...command.prefixArgs, 'app-server', '--listen', `unix://${socketPath}`],
    {
      cwd: input.cwd,
      env: { ...process.env, CODEX_HOME: input.codexHome },
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true
    }
  )
  let spawnError: Error | null = null
  child.on('error', (error) => {
    spawnError = error
  })
  let socketIdentity: ControlledCodexServer['socketIdentity'] | null = null
  try {
    await waitForSocket(child, socketPath, () => spawnError)
    const stat = lstatSync(socketPath)
    socketIdentity = { dev: stat.dev, ino: stat.ino }
    const ownedSocketIdentity = socketIdentity
    child.once('exit', () => removeOwnedSocket(socketPath, ownedSocketIdentity))
    hardenSocket(socketPath, 0o600)
    return { process: child, socketIdentity }
  } catch (error) {
    await stopControlledCodexServer({ process: child, socketIdentity }, socketPath)
    throw error
  }
}

export async function stopControlledCodexServer(
  server: { process: ChildProcess; socketIdentity: ControlledCodexServer['socketIdentity'] | null },
  socketPath: string
): Promise<void> {
  const child = server.process
  if (!hasChildExited(child)) {
    child.kill('SIGTERM')
    if (!(await waitForExit(child, PROCESS_STOP_TIMEOUT_MS))) {
      child.kill('SIGKILL')
      if (!(await waitForExit(child, PROCESS_STOP_TIMEOUT_MS))) {
        throw new Error('controlled Codex app-server did not exit after SIGKILL')
      }
    }
  }
  if (server.socketIdentity) {
    removeOwnedSocket(socketPath, server.socketIdentity)
  }
}

export function assertControlledServerIdentity(result: unknown, expectedHome: string): void {
  if (
    !isRecord(result) ||
    result.platformFamily !== 'unix' ||
    result.codexHome !== resolve(expectedHome)
  ) {
    throw new Error('controlled Codex app-server identity mismatch')
  }
}

export function failControlledTerminalIdentity(kind: 'tab' | 'pane' | 'workspace'): never {
  throw new Error(`controlled Codex visible terminal lacks a stable ${kind} identity`)
}

export function extractControlledThreadId(response: unknown): string {
  if (!isRecord(response) || !isRecord(response.thread) || typeof response.thread.id !== 'string') {
    throw new Error('controlled Codex thread/start returned an invalid response')
  }
  return response.thread.id
}

export async function assertControlledThreadAlive(
  client: { request(method: string, params?: Record<string, unknown>): Promise<unknown> },
  threadId: string
): Promise<void> {
  const response = await client.request('thread/read', { threadId, includeTurns: false })
  if (!isRecord(response) || !isRecord(response.thread) || response.thread.id !== threadId) {
    throw new Error('controlled Codex app-server thread is not ready')
  }
}

export function controlledLaunchOutcomeUnknown(error: unknown): Error {
  const wrapped = error instanceof Error ? error : new Error(String(error))
  Object.assign(wrapped, { agentSessionOperationOutcome: 'unknown' as const })
  return wrapped
}

async function waitForSocket(
  child: ChildProcess,
  socketPath: string,
  getSpawnError: () => Error | null
): Promise<void> {
  const deadline = Date.now() + SOCKET_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    const spawnError = getSpawnError()
    if (spawnError) {
      throw spawnError
    }
    if (hasChildExited(child)) {
      throw new Error('controlled Codex app-server exited before ready')
    }
    if (existsSync(socketPath) && lstatSync(socketPath).isSocket()) {
      return
    }
    await new Promise((resolveReady) => setTimeout(resolveReady, 20))
  }
  throw new Error('controlled Codex app-server socket did not become ready')
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasChildExited(child)) {
    return Promise.resolve(true)
  }
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit)
      resolveExit(false)
    }, timeoutMs)
    timer.unref?.()
    const onExit = (): void => {
      clearTimeout(timer)
      resolveExit(true)
    }
    child.once('exit', onExit)
  })
}

function hasChildExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode != null
}

function removeOwnedSocket(
  socketPath: string,
  identity: ControlledCodexServer['socketIdentity']
): void {
  try {
    const current = lstatSync(socketPath)
    if (current.isSocket() && current.dev === identity.dev && current.ino === identity.ino) {
      rmSync(socketPath)
    }
  } catch {
    // The socket is already absent or no longer ours.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
