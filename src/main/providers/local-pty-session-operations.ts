import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import type * as pty from 'node-pty'
import { readPtsName } from '../pty/node-pty-pts-name'
import { signalPosixPtyForegroundGroup } from '../pty/posix-pty-foreground-group'
import { ptyShellProcessId } from '../windows/windows-pty-job'
import { isWslAvailableAsync } from '../wsl'
import { resolveGitBashPath } from '../git-bash'
import { resolveProcessCwd } from './process-cwd'
import {
  dataListeners,
  exitListeners,
  ptyIncarnations,
  ptyInitialCwd,
  ptyProcesses,
  getPtyShellName,
  ptyTerminalHandle,
  ptyWorktreeId,
  ptyWslDistroById,
  startupIngressByPty,
  type DataCallback,
  type ExitCallback
} from './local-pty-provider-state'
import type { LocalPtyProviderOptions } from './local-pty-provider-types'
import type { PtyProcessInfo } from './pty-provider-contract'

export function writeLocalPty(id: string, data: string): boolean {
  // Hold private DSR/OSC replies through cooked-mode echo; CPR/DA cannot overtake held replies (#13137, #7329, #15559).
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

// Pausing master reads blocks flooding children on kernel writes instead of growing main-process buffers.
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

// node-pty cols/rows reflect applied clamping/no-ops; renderer drift checks need this readback.
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
  if ('signalProcess' in proc && typeof proc.signalProcess === 'function') {
    proc.signalProcess(signal)
    return
  }
  const signalRootPid = (): void => {
    try {
      process.kill(proc.pid, signal)
    } catch {
      /* Process may already be dead */
    }
  }
  // Real SIGWINCH reaches the tty foreground group, which excludes proc.pid (posix-pty-foreground-group).
  if (signal === 'SIGWINCH') {
    await signalPosixPtyForegroundGroup(proc.pid, readPtsName(proc), signal, signalRootPid, {
      ownsRoot: () => ptyProcesses.get(id) === proc
    })
    return
  }
  signalRootPid()
}

export async function getLocalPtyCwd(id: string): Promise<string> {
  const proc = ptyProcesses.get(id)
  // Empty cwd lets the renderer try its next fallback for a missing PTY.
  if (!proc) {
    return ''
  }
  // Preserve unknown cwd as empty; a fabricated path would suppress renderer fallbacks.
  const shellPid = ptyShellProcessId(proc)
  return shellPid === undefined ? '' : resolveProcessCwd(shellPid)
}

export async function clearLocalPtyBuffer(id: string): Promise<void> {
  // ConPTY retains a screen buffer beyond xterm.clear(); clear it to prevent stale cursor gaps.
  // Omit the daemon PSReadLine nudge: this provider cannot prove the prompt is empty.
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
    ...(proc.pid > 0 ? { rootProcessId: proc.pid } : {}),
    cwd: ptyInitialCwd.get(id) ?? '',
    title: proc.process || getPtyShellName(id) || 'shell',
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
  return process.env.SHELL?.trim() || '/bin/zsh'
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
