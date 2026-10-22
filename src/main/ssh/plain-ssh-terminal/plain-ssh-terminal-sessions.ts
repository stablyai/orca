/**
 * Plain SSH terminals: an unmanaged `ssh` login to a host whose move to its Orca server is blocked,
 * so the user can keep working there meanwhile. A session is not an Orca workspace or terminal:
 * nothing persists or restores it, no agent or status runs in it, and it never marks the host
 * connected. One per host; it ends when ssh exits, its window closes or reloads, or Orca quits.
 */
import { randomUUID } from 'node:crypto'
import type * as pty from 'node-pty'
import type { SshTarget } from '../../../shared/ssh-types'
import type {
  PlainSshTerminalEvent,
  PlainSshTerminalOpenResult
} from '../../../shared/plain-ssh-terminal'
import { buildInheritedLocalPtyEnvironment } from '../../providers/local-pty-spawn-environment'
import { spawnPtyExecutable } from '../../providers/local-pty-utils'
import { destroyPtyProcess } from '../../providers/local-pty-termination'
import { buildPlainSshTerminalArgs } from './plain-ssh-terminal-args'

export type PlainSshTerminalDeps = {
  getTarget: (targetId: string) => SshTarget | undefined
  /** True only while the host's move to its Orca server is blocked. */
  isMoveBlocked: (targetId: string) => boolean
  findSsh: () => string | null
  mayConfigClaimAlias: (alias: string) => boolean
  loadPtySpawn: () => Promise<typeof pty.spawn>
  homeDir: () => string
  platform: NodeJS.Platform
}

/** Where a session's output and exit go; false once that window is gone. */
type PlainSshTerminalSink = (event: PlainSshTerminalEvent) => boolean

type Session = {
  id: string
  owner: number
  proc: pty.IPty
  exited: Promise<void>
  hungUp: boolean
  /** Output sent but not yet rendered by the window, in UTF-16 units. */
  unacked: number
  paused: boolean
}

/** A host's one claim, taken before the first await so concurrent opens can't both spawn. */
type Slot = { owner: number; token: symbol; session: Session | null }

const FORCE_KILL_AFTER_MS = 5_000
const QUIT_FORCE_KILL_AFTER_MS = 1_000
// Why: a flood (cat of a big file) must wait for the window to render, not pile up in IPC.
const PAUSE_ABOVE_UNACKED = 512 * 1024
const RESUME_BELOW_UNACKED = 128 * 1024
const MIN_SIZE = 2
const MAX_SIZE = 1_000

const slots = new Map<string, Slot>()
/** Every process not yet exited, including ones already hung up. */
const sessions = new Map<string, Session>()
let quitting = false

function sshMissingMessage(platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? 'Orca couldn’t find OpenSSH (ssh.exe) on this computer. Install “OpenSSH Client” in Windows Settings > System > Optional features, then try again.'
    : 'Orca couldn’t find ssh on this computer. Install the OpenSSH client, then try again.'
}

function clampSize(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.floor(value)))
    : fallback
}

/** Frees a host's claim; a live session in it is hung up. */
function releaseSlot(targetId: string, slot: Slot): void {
  if (slots.get(targetId) === slot) {
    slots.delete(targetId)
  }
  if (slot.session) {
    hangUp(slot.session, FORCE_KILL_AFTER_MS)
  }
}

/**
 * Why: on Windows node-pty records the exit before it emits one, and a native call in that gap
 * throws ("already exited"). From an IPC listener that would reach the fatal main-process guard.
 */
function onLivePty(session: Session, call: (proc: pty.IPty) => void): void {
  try {
    call(session.proc)
  } catch {
    // Exited; its exit event follows.
  }
}

function hangUp(session: Session, forceAfterMs: number): void {
  if (!session.hungUp) {
    session.hungUp = true
    if (session.paused) {
      // Why: a paused Windows pty never reads its socket's end, so it would never report exit.
      session.paused = false
      onLivePty(session, (proc) => proc.resume())
    }
    try {
      session.proc.kill()
    } catch {
      // Already gone; its exit cleans up.
    }
  }
  // Why armed again when already hung up: quit's shorter deadline must apply to it too.
  const forceKill = setTimeout(() => {
    if (sessions.has(session.id)) {
      try {
        // Why: Windows rejects a signal name; its kill() above already terminated the console.
        session.proc.kill('SIGKILL')
      } catch {
        // Already gone.
      }
    }
  }, forceAfterMs)
  forceKill.unref?.()
  void session.exited.then(() => clearTimeout(forceKill))
}

export async function openPlainSshTerminal(
  deps: PlainSshTerminalDeps,
  request: { targetId: unknown; cols: unknown; rows: unknown; owner: number },
  sink: PlainSshTerminalSink
): Promise<PlainSshTerminalOpenResult> {
  const targetId = typeof request.targetId === 'string' ? request.targetId : ''
  const target = targetId ? deps.getTarget(targetId) : undefined
  // Why `owner`: internal targets (a server's own SSH hops) are never the user's host.
  if (!target || target.owner) {
    return { ok: false, reason: 'unknown-target' }
  }
  if (!deps.isMoveBlocked(target.id)) {
    return { ok: false, reason: 'not-blocked' }
  }
  if (quitting) {
    return { ok: false, reason: 'cancelled' }
  }
  const held = slots.get(target.id)
  if (held && held.owner !== request.owner) {
    return { ok: false, reason: 'already-open' }
  }
  // Why the same window may replace its own: it shows one per host, so an older one is stale.
  if (held) {
    releaseSlot(target.id, held)
  }
  const slot: Slot = { owner: request.owner, token: Symbol(target.id), session: null }
  slots.set(target.id, slot)
  const stillClaimed = (): boolean => !quitting && slots.get(target.id)?.token === slot.token

  const sshPath = deps.findSsh()
  if (!sshPath) {
    releaseSlot(target.id, slot)
    return { ok: false, reason: 'ssh-missing', message: sshMissingMessage(deps.platform) }
  }
  const args = buildPlainSshTerminalArgs(
    target,
    target.configHost && !deps.mayConfigClaimAlias(target.configHost)
      ? { aliasClaimedByConfig: false }
      : undefined
  )
  let proc: pty.IPty
  try {
    const ptySpawn = await deps.loadPtySpawn()
    // A reload, a newer open or quit during the await took the claim; spawn nothing.
    if (!stillClaimed()) {
      return { ok: false, reason: 'cancelled' }
    }
    proc = spawnPtyExecutable({
      file: sshPath,
      args,
      cols: clampSize(request.cols, 80),
      rows: clampSize(request.rows, 24),
      cwd: deps.homeDir(),
      env: buildInheritedLocalPtyEnvironment(undefined),
      ptySpawn
    })
  } catch (error) {
    releaseSlot(target.id, slot)
    return {
      ok: false,
      reason: 'spawn-failed',
      message: error instanceof Error ? error.message : String(error)
    }
  }
  let markExited: () => void = () => {}
  const session: Session = {
    id: randomUUID(),
    owner: request.owner,
    proc,
    exited: new Promise((resolve) => {
      markExited = resolve
    }),
    hungUp: false,
    unacked: 0,
    paused: false
  }
  sessions.set(session.id, session)
  slot.session = session
  proc.onData((data) => {
    if (session.hungUp) {
      return
    }
    if (!sink({ kind: 'data', sessionId: session.id, data })) {
      releaseSlot(target.id, slot)
      return
    }
    session.unacked += data.length
    if (!session.paused && session.unacked > PAUSE_ABOVE_UNACKED) {
      session.paused = true
      onLivePty(session, (live) => live.pause())
    }
  })
  proc.onExit(({ exitCode, signal }) => {
    sessions.delete(session.id)
    if (slots.get(target.id) === slot) {
      slots.delete(target.id)
    }
    destroyPtyProcess(proc, { alreadyKilled: true })
    markExited()
    sink({
      kind: 'exit',
      sessionId: session.id,
      exitCode,
      ...(signal ? { signal } : {})
    })
  })
  return { ok: true, sessionId: session.id, label: target.label }
}

function ownedSession(sessionId: unknown, owner: number): Session | null {
  const session = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined
  return session && session.owner === owner && !session.hungUp ? session : null
}

export function writePlainSshTerminal(sessionId: unknown, owner: number, data: unknown): void {
  const session = ownedSession(sessionId, owner)
  if (session && typeof data === 'string') {
    onLivePty(session, (proc) => proc.write(data))
  }
}

export function resizePlainSshTerminal(
  sessionId: unknown,
  owner: number,
  cols: unknown,
  rows: unknown
): void {
  const session = ownedSession(sessionId, owner)
  if (session) {
    onLivePty(session, (proc) =>
      proc.resize(clampSize(cols, proc.cols), clampSize(rows, proc.rows))
    )
  }
}

export function ackPlainSshTerminal(sessionId: unknown, owner: number, chars: unknown): void {
  const session = ownedSession(sessionId, owner)
  if (!session || typeof chars !== 'number' || !Number.isFinite(chars) || chars <= 0) {
    return
  }
  session.unacked = Math.max(0, session.unacked - chars)
  if (session.paused && session.unacked < RESUME_BELOW_UNACKED) {
    session.paused = false
    onLivePty(session, (proc) => proc.resume())
  }
}

/** Hangs up ssh and frees its host at once; a stuck process is killed outright later. */
export function closePlainSshTerminal(sessionId: unknown, owner: number): void {
  const session = ownedSession(sessionId, owner)
  if (!session) {
    return
  }
  for (const [targetId, slot] of slots) {
    if (slot.session === session) {
      releaseSlot(targetId, slot)
      return
    }
  }
  hangUp(session, FORCE_KILL_AFTER_MS)
}

/** Every session a window owns, opened or still opening, e.g. when it closes or reloads. */
export function closePlainSshTerminalsOwnedBy(owner: number): void {
  for (const [targetId, slot] of slots) {
    if (slot.owner === owner) {
      releaseSlot(targetId, slot)
    }
  }
}

/** On quit: nothing restores these, so none may outlive Orca. Resolves once all have exited. */
export async function closeAllPlainSshTerminals(): Promise<void> {
  quitting = true
  slots.clear()
  const pending = [...sessions.values()]
  for (const session of pending) {
    hangUp(session, QUIT_FORCE_KILL_AFTER_MS)
  }
  await Promise.all(pending.map((session) => session.exited))
}

/** Test seam: quit is one-way in a real app. */
export function resetPlainSshTerminalsForTests(): void {
  quitting = false
  slots.clear()
  sessions.clear()
}
