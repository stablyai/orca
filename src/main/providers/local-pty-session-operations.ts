import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import type * as pty from 'node-pty'
import { readPtsName } from '../pty/node-pty-pts-name'
import { signalPosixPtyForegroundGroup } from '../pty/posix-pty-foreground-group'
import { isWslAvailableAsync } from '../wsl'
import { resolveGitBashPath } from '../git-bash'
import { resolveProcessCwd } from './process-cwd'
import {
  dataListeners,
  exitListeners,
  ptyIncarnations,
  ptyInitialCwd,
  ptyProcesses,
  ptyShellName,
  ptyTerminalHandle,
  ptyWorktreeId,
  ptyWslDistroById,
  startupIngressByPty,
  type DataCallback,
  type ExitCallback
} from './local-pty-provider-state'
import type { LocalPtyProviderOptions } from './local-pty-provider-types'
import type { PtyProcessInfo } from './types'

export function writeLocalPty(id: string, data: string): boolean {
  // Cooked PTYs echo private DSR/OSC replies; CPR/DA stay immediate unless one of
  // those is still held, which they must not overtake (#13137, #7329, #15559).
  if (startupIngressByPty.get(id)?.answerLiveQueryReply(data)) {
    return true
  }
  const proc = ptyProcesses.get(id)
  if (!proc) {
    return false
  }
  proc.write(data)
  return true
}

export function resizeLocalPty(id: string, cols: number, rows: number): void {
  ptyProcesses.get(id)?.resize(cols, rows)
}

// Why: node-pty pause() stops reading the master fd, so a flooding child blocks on write — true producer backpressure.
export function pauseLocalPtyProducer(id: string): void {
  try {
    ptyProcesses.get(id)?.pause()
  } catch {
    /* PTY already destroyed */
  }
}

export function resumeLocalPtyProducer(id: string): void {
  try {
    ptyProcesses.get(id)?.resume()
  } catch {
    /* PTY already destroyed */
  }
}

// Why: proc.cols/rows are node-pty's authoritative applied size (post-clamp/no-op), used by the renderer drift-check.
export async function getLocalPtyAppliedSize(
  id: string
): Promise<{ cols: number; rows: number } | null> {
  const proc = ptyProcesses.get(id)
  if (!proc || proc.cols <= 0 || proc.rows <= 0) {
    return null
  }
  return { cols: proc.cols, rows: proc.rows }
}

export async function sendLocalPtySignal(id: string, signal: string): Promise<void> {
  const proc = ptyProcesses.get(id)
  if (!proc) {
    return
  }
  const signalRootPid = (): void => {
    try {
      process.kill(proc.pid, signal)
    } catch {
      /* Process may already be dead */
    }
  }
  // Why only SIGWINCH: see posix-pty-foreground-group — a real resize reaches the
  // tty's foreground group, which proc.pid is never a member of.
  if (signal === 'SIGWINCH') {
    signalPosixPtyForegroundGroup(proc.pid, readPtsName(proc), signal, signalRootPid)
    return
  }
  signalRootPid()
}

export async function getLocalPtyCwd(id: string): Promise<string> {
  const proc = ptyProcesses.get(id)
  // Why: '' not throw on unknown id — renderer reads empty as "try next fallback"; throwing is noisy for a normal case.
  if (!proc) {
    return ''
  }
  // Why: let resolveProcessCwd's '' surface for the renderer fallback chain; a fabricated cwd would short-circuit it.
  return resolveProcessCwd(proc.pid)
}

export async function clearLocalPtyBuffer(id: string): Promise<void> {
  // Why: ConPTY keeps its own screen buffer, so xterm clear() alone leaves a stale-cursor gap on the next prompt; POSIX no-op.
  // No PSReadLine form-feed nudge here (unlike the daemon): safe only at an empty prompt, which this provider can't detect.
  try {
    startupIngressByPty.get(id)?.snapshotBarrier()
    ptyProcesses.get(id)?.clear()
  } catch {
    /* PTY may have just exited */
  }
}

export function closeLocalPtyStartupQueryAuthority(id: string): number {
  return startupIngressByPty.get(id)?.closeQueryAuthority() ?? 0
}

export async function listLocalPtyProcesses(): Promise<PtyProcessInfo[]> {
  return Array.from(ptyProcesses.entries()).map(([id, proc]) => ({
    id,
    ...(ptyIncarnations.get(id) ? { incarnationId: ptyIncarnations.get(id) } : {}),
    cwd: ptyInitialCwd.get(id) ?? '',
    title: proc.process || ptyShellName.get(id) || 'shell',
    ...(ptyWorktreeId.get(id) ? { worktreeId: ptyWorktreeId.get(id) } : {}),
    ...(ptyTerminalHandle.get(id) ? { terminalHandle: ptyTerminalHandle.get(id) } : {}),
    ...(ptyWslDistroById.has(id) ? { wslDistro: ptyWslDistroById.get(id) ?? null } : {})
  }))
}

export async function getDefaultLocalPtyShell(
  getOptions: () => LocalPtyProviderOptions
): Promise<string> {
  if (process.platform === 'win32') {
    return getOptions().getWindowsShell?.() || process.env.COMSPEC || 'powershell.exe'
  }
  return process.env.SHELL || '/bin/zsh'
}

export async function getLocalPtyProfiles(): Promise<{ name: string; path: string }[]> {
  if (process.platform === 'win32') {
    const profiles: { name: string; path: string }[] = [
      { name: 'PowerShell', path: 'powershell.exe' },
      { name: 'Command Prompt', path: 'cmd.exe' }
    ]
    const gitBashPath = resolveGitBashPath()
    if (gitBashPath) {
      profiles.push({ name: 'Git Bash', path: gitBashPath })
    }
    if (await isWslAvailableAsync()) {
      profiles.push({ name: 'WSL', path: 'wsl.exe' })
    }
    return profiles
  }
  const shells = ['/bin/zsh', '/bin/bash', '/bin/sh']
  return shells.filter((s) => existsSync(s)).map((s) => ({ name: basename(s), path: s }))
}

export function onLocalPtyData(callback: DataCallback): () => void {
  dataListeners.add(callback)
  return () => dataListeners.delete(callback)
}

export function onLocalPtyExit(callback: ExitCallback): () => void {
  exitListeners.add(callback)
  return () => exitListeners.delete(callback)
}

export function getLocalPtyProcess(id: string): pty.IPty | undefined {
  return ptyProcesses.get(id)
}
