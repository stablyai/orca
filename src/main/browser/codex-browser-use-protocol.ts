import { join } from 'node:path'
import type { Socket } from 'node:net'

export type CodexBrowserUseTab = {
  browserPageId: string
  url: string
  title: string
  active: boolean
}

export type CodexBrowserUseCdpTarget = {
  tabId: number
  sessionId?: string
  targetId?: string
}

export type RpcNotificationEmitter = (method: string, params: unknown) => void

export type CodexBrowserUseRpcRequest = {
  jsonrpc: '2.0'
  id?: number | string
  method: string
  params?: Record<string, unknown>
}

export type CodexBrowserUseSession = {
  sessionId: string
  worktreeId: string
  pageIdByTabId: Map<number, string>
  tabIdByPageId: Map<string, number>
  nextTabId: number
}

export type CodexBrowserUseBackendOptions = {
  socketPath?: string
  platform?: NodeJS.Platform
  processId?: number
}

export type CodexBrowserUseAdapter = {
  resolveWorktreeId: (sessionId: string) => string | null
  listTabs: (worktreeId: string) => CodexBrowserUseTab[]
  attach: (
    connectionId: string,
    sessionId: string,
    worktreeId: string,
    browserPageId: string,
    tabId: number,
    emit: RpcNotificationEmitter
  ) => void | Promise<void>
  attachTarget?: (
    connectionId: string,
    sessionId: string,
    worktreeId: string,
    browserPageId: string,
    tabId: number,
    targetId: string
  ) => void | Promise<void>
  detach: (
    connectionId: string,
    sessionId: string,
    worktreeId: string,
    browserPageId: string
  ) => void | Promise<void>
  detachTarget?: (
    connectionId: string,
    sessionId: string,
    worktreeId: string,
    browserPageId: string,
    targetId: string
  ) => void | Promise<void>
  executeCdp: (
    connectionId: string,
    sessionId: string,
    worktreeId: string,
    browserPageId: string,
    target: CodexBrowserUseCdpTarget,
    method: string,
    params: Record<string, unknown>
  ) => unknown | Promise<unknown>
}

export function requireBrowserUseString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} is required`)
  }
  return value
}

export function asBrowserUseRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function asBrowserUseCdpTarget(value: unknown): CodexBrowserUseCdpTarget {
  const record = asBrowserUseRecord(value)
  const tabId = Number(record.tabId)
  if (!Number.isSafeInteger(tabId) || tabId < 1) {
    throw new Error('target.tabId is required')
  }
  return {
    tabId,
    ...(typeof record.sessionId === 'string' ? { sessionId: record.sessionId } : {}),
    ...(typeof record.targetId === 'string' ? { targetId: record.targetId } : {})
  }
}

export function defaultCodexBrowserUseSocketPath(
  platform: NodeJS.Platform,
  processId = process.pid
): string {
  return platform === 'win32'
    ? `\\\\.\\pipe\\codex-browser-use-orca-${processId}`
    : join('/tmp', 'codex-browser-use', `orca-${processId}.sock`)
}

export function sendBrowserUseMessage(socket: Socket, message: unknown): void {
  if (socket.destroyed) {
    return
  }
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const frame = Buffer.allocUnsafe(body.length + 4)
  frame.writeUInt32LE(body.length, 0)
  body.copy(frame, 4)
  socket.write(frame)
}
