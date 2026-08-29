import { release } from 'node:os'
import {
  DESKTOP_HOST_CAPABILITIES,
  DESKTOP_HOST_KIND,
  type DesktopHostStatus,
  type DesktopPtyKillArgs,
  type DesktopPtyResizeArgs,
  type DesktopPtySpawnArgs,
  type DesktopPtyWriteArgs
} from '../shared/desktop-host-protocol'
import { RUNTIME_PROTOCOL_VERSION } from '../shared/protocol-version'
import type { DesktopHostPtyBroker } from './desktop-host-pty'

export type DesktopHostRpcContext = {
  runtimeId: string
  pty: DesktopHostPtyBroker
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function spawnArgs(value: unknown): DesktopPtySpawnArgs {
  const record = asRecord(value)
  return {
    cols: readNumber(record.cols, 80),
    rows: readNumber(record.rows, 24),
    cwd: readString(record.cwd),
    command: readString(record.command),
    env:
      record.env && typeof record.env === 'object' && !Array.isArray(record.env)
        ? (record.env as Record<string, string>)
        : undefined
  }
}

function writeArgs(value: unknown): DesktopPtyWriteArgs {
  const record = asRecord(value)
  return {
    id: readString(record.id) ?? '',
    data: readString(record.data) ?? ''
  }
}

function resizeArgs(value: unknown): DesktopPtyResizeArgs {
  const record = asRecord(value)
  return {
    id: readString(record.id) ?? '',
    cols: readNumber(record.cols, 80),
    rows: readNumber(record.rows, 24)
  }
}

function killArgs(value: unknown): DesktopPtyKillArgs {
  return { id: readString(asRecord(value).id) ?? '' }
}

export function createDesktopHostStatus(runtimeId: string): DesktopHostStatus {
  return {
    runtimeId,
    host: DESKTOP_HOST_KIND,
    graphStatus: 'ready',
    authoritativeWindowId: null,
    liveTabCount: 0,
    liveLeafCount: 0,
    rendererGraphEpoch: 0,
    runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
    capabilities: [...DESKTOP_HOST_CAPABILITIES],
    hostPlatform: process.platform
  }
}

export function invokeDesktopHostChannel(
  context: DesktopHostRpcContext,
  channel: string,
  args: unknown
): unknown {
  switch (channel) {
    case 'host:status':
    case 'status.get':
      return createDesktopHostStatus(context.runtimeId)
    case 'host:platform':
    case 'host.platform':
      return { platform: process.platform, osRelease: release() }
    case 'pty:spawn':
    case 'desktop.pty.spawn':
      return context.pty.spawn(spawnArgs(args))
    case 'pty:writeAccepted':
    case 'desktop.pty.write':
      return context.pty.write(writeArgs(args))
    case 'pty:kill':
    case 'desktop.pty.kill':
      return { killed: context.pty.kill(killArgs(args)) }
    case 'pty:listSessions':
    case 'desktop.pty.list':
      return context.pty.listSessions()
    case 'pty:getCwd':
    case 'desktop.pty.cwd': {
      const id = readString(asRecord(args).id) ?? ''
      return context.pty.getCwd(id) ?? ''
    }
    case 'pty:hasChildProcesses':
      return false
    case 'pty:getForegroundProcess':
      return null
    default:
      throw Object.assign(new Error(`Unknown desktop host method: ${channel}`), {
        code: 'method_not_found'
      })
  }
}

export function sendDesktopHostChannel(
  context: DesktopHostRpcContext,
  channel: string,
  args: unknown
): void {
  switch (channel) {
    case 'pty:write':
      context.pty.write(writeArgs(args))
      return
    case 'pty:resize':
    case 'desktop.pty.resize':
      context.pty.resize(resizeArgs(args))
      return
    case 'pty:signal':
    case 'pty:ackColdRestore':
    case 'pty:ackData':
    case 'pty:setActiveRendererPty':
    case 'pty:reportGeometry':
      return
    default:
      throw Object.assign(new Error(`Unknown desktop host send channel: ${channel}`), {
        code: 'method_not_found'
      })
  }
}
