import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RuntimeTerminalListResult, RuntimeTerminalSummary } from '../../shared/runtime-types'
import { RuntimeClientError } from '../runtime-client'

export const KEY_MAP: Record<string, string> = {
  Enter: '\r',
  Return: '\r',
  Escape: '\x1b',
  Esc: '\x1b',
  'C-c': '\x03',
  'C-d': '\x04',
  'C-z': '\x1a',
  Tab: '\t',
  Up: '\x1b[A',
  Down: '\x1b[B',
  Right: '\x1b[C',
  Left: '\x1b[D',
  Backspace: '\x7f',
  Space: ' '
}

export function getReadGuardPath(handle: string): string {
  const sanitized = handle.replace(/[^a-zA-Z0-9_-]/g, '_')
  return join(tmpdir(), `orca-bridge-read-${sanitized}`)
}

export function markRead(handle: string): void {
  try {
    writeFileSync(getReadGuardPath(handle), Date.now().toString(), 'utf8')
  } catch {
    // Best-effort marker
  }
}

export function requireRead(handle: string, targetDisplay: string, bypass = false): void {
  if (bypass) {
    return
  }
  const guardPath = getReadGuardPath(handle)
  if (!existsSync(guardPath)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `must read the terminal before interacting. Run: orca bridge read ${targetDisplay}`
    )
  }
}

export function clearRead(handle: string): void {
  try {
    const guardPath = getReadGuardPath(handle)
    if (existsSync(guardPath)) {
      unlinkSync(guardPath)
    }
  } catch {
    // Best-effort
  }
}

export function formatBridgeList(result: RuntimeTerminalListResult): string {
  if (result.terminals.length === 0) {
    return 'No terminals found in current worktree.'
  }
  const header = `${'TARGET'.padEnd(8)} ${'INDEX'.padEnd(7)} ${'STATUS'.padEnd(12)} ${'LABEL / TITLE'.padEnd(24)} HANDLE`
  const lines = result.terminals.map((t: RuntimeTerminalSummary) => {
    const target = (t.target || '-').padEnd(8)
    const index = (t.index !== undefined ? String(t.index) : '-').padEnd(7)
    const status = (t.connected ? 'connected' : 'disconnected').padEnd(12)
    const title = (t.label || t.title || '(untitled)').slice(0, 23).padEnd(24)
    return `${target} ${index} ${status} ${title} ${t.handle}`
  })
  return [header, ...lines].join('\n')
}
