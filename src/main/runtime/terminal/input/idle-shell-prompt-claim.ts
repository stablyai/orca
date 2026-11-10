import { readFile } from 'node:fs/promises'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { isShellProcess } from '../../../../shared/agent-status/process/shell-process-detection'
import type { RuntimePtyController } from '../lifecycle/runtime-pty-controller-contract'

// A hung host proof must not outlast the settle it would have saved.
const SHELL_FOREGROUND_PROOF_DEADLINE_MS = 250

export type IdleShellPromptEvidence = {
  /** Launch/foreground records or any agent-status row, live or stale. */
  hasPaneAgent: () => boolean
  /** Consumes the OSC 133 hint so back-to-back sends cannot reuse one prompt. */
  claimPromptMarker: () => boolean
  /** The execution host's proof that the shell itself owns the terminal foreground. */
  confirmShellForeground: (() => Promise<boolean>) | null
}

/** True only when markers and the execution host both prove a bare shell at its prompt. */
export async function claimIdleShellPrompt(evidence: IdleShellPromptEvidence): Promise<boolean> {
  if (evidence.hasPaneAgent() || !evidence.claimPromptMarker()) {
    return false
  }
  const proof = evidence.confirmShellForeground?.()
  if (!proof) {
    return false
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), SHELL_FOREGROUND_PROOF_DEADLINE_MS)
    timer.unref?.()
  })
  try {
    return await Promise.race([proof.catch(() => false), deadline])
  } finally {
    clearTimeout(timer)
  }
}

type ShellForegroundController = Pick<
  RuntimePtyController,
  'confirmShellForeground' | 'listProcesses'
>

/** The host proof for one PTY, or null when its controller cannot prove a shell foreground at all. */
export function idleShellForegroundProof(
  controller: ShellForegroundController | null | undefined,
  ptyId: string
): (() => Promise<boolean>) | null {
  return controller?.confirmShellForeground
    ? () => confirmIdleShellForeground(controller, ptyId)
    : null
}

/** Daemon PTYs prove lifecycle ownership only after a full-screen exit, never for a fresh or
 * plain-command shell, so every Enter paid the paste settle. Linux reads the shell's own /proc stat
 * for that proof (no ps); other hosts keep the provider's answer. */
export async function confirmIdleShellForeground(
  controller: ShellForegroundController,
  ptyId: string,
  readStat: (pid: number) => Promise<string> = readProcStat
): Promise<boolean> {
  if (await controller.confirmShellForeground?.(ptyId)) {
    return true
  }
  if (process.platform !== 'linux' || !controller.listProcesses) {
    return false
  }
  try {
    const rows = await controller.listProcesses(LOCAL_EXECUTION_HOST_ID, {
      ptyIds: [ptyId],
      targetOwnerOnly: true
    })
    const pid = rows.find((row) => row.id === ptyId)?.rootProcessId
    return pid ? linuxShellOwnsForeground(await readStat(pid)) : false
  } catch {
    return false
  }
}

function readProcStat(pid: number): Promise<string> {
  return readFile(`/proc/${pid}/stat`, 'utf8')
}

/** `pid (comm) state ppid pgrp session tty_nr tpgid ...`: a shell whose process group is its
 * terminal's foreground group, which is what ps marks with `+`. comm may contain spaces or ')'. */
export function linuxShellOwnsForeground(stat: string): boolean {
  const open = stat.indexOf('(')
  const close = stat.lastIndexOf(')')
  if (open === -1 || close < open) {
    return false
  }
  if (!isShellProcess(stat.slice(open + 1, close))) {
    return false
  }
  const [state, , pgrp, , ttyNr, tpgid] = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/)
  if (!state || state === 'T' || state === 't' || state === 'Z' || state === 'X') {
    return false
  }
  const group = Number(pgrp)
  return Number(ttyNr) !== 0 && group > 0 && Number(tpgid) === group
}
