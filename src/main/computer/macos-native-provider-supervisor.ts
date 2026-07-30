import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  COMPUTER_PROVIDER_SUPERVISOR_CHANNEL,
  type ComputerProviderSupervisorEvent,
  type StartedSupervisedMacOSProvider
} from './computer-provider-supervisor-protocol'
import { resolveMacOSComputerUseExecutablePath } from './macos-native-provider-paths'
import { RuntimeClientError } from './runtime-client-error'

// Why: the parent deadline must outlast the 10-second connect budget and claim IPC.
export const MACOS_HELPER_CLAIM_TIMEOUT_MS = 20_000
export const MACOS_HELPER_FORCE_KILL_GRACE_MS = 1_000

type SupervisedMacOSProviderSession = {
  id: string
  pid: number
  child: ChildProcess
  socketDirectory: string
  socketTokenPath: string
  claimTimer: NodeJS.Timeout
  forceKillTimer: NodeJS.Timeout | null
  terminating: boolean
  cleanupListeners: () => void
}

export type MacOSNativeProviderSupervisorDeps = {
  resolveExecutablePath: () => string | null
  spawn: typeof spawn
  randomUUID: () => string
  mkdtempSync: typeof mkdtempSync
  chmodSync: typeof chmodSync
  writeFileSync: typeof writeFileSync
  rmSync: typeof rmSync
  setTimer: (callback: () => void, timeoutMs: number) => NodeJS.Timeout
  clearTimer: (timer: NodeJS.Timeout) => void
}

function ignoreUnownedChildError(): void {}

export class MacOSNativeProviderSupervisor {
  private readonly sessions = new Map<string, SupervisedMacOSProviderSession>()
  private readonly deps: MacOSNativeProviderSupervisorDeps

  constructor(
    private readonly emitEvent: (event: ComputerProviderSupervisorEvent) => void = () => {},
    deps?: MacOSNativeProviderSupervisorDeps
  ) {
    this.deps = deps ?? createDefaultDeps()
  }

  start(): StartedSupervisedMacOSProvider {
    const executablePath = this.deps.resolveExecutablePath()
    if (!executablePath) {
      throw new RuntimeClientError('accessibility_error', 'Orca Computer Use.app was not found')
    }

    let socketDirectory: string | null = null
    let child: ChildProcess | null = null
    try {
      socketDirectory = this.deps.mkdtempSync(join(tmpdir(), 'orca-computer-use-'))
      this.deps.chmodSync(socketDirectory, 0o700)
      const socketPath = join(socketDirectory, 'provider.sock')
      const socketToken = this.deps.randomUUID()
      const socketTokenPath = join(socketDirectory, 'provider.token')
      this.deps.writeFileSync(socketTokenPath, socketToken, { encoding: 'utf8', mode: 0o600 })
      child = this.deps.spawn(
        executablePath,
        ['--agent', socketPath, '--token-file', socketTokenPath],
        { detached: true, stdio: 'ignore' }
      )
      child.on('error', ignoreUnownedChildError)
      if (typeof child.pid !== 'number' || child.pid <= 0) {
        throw new Error('helper process did not report a pid')
      }

      const sessionId = this.deps.randomUUID()
      child.unref()
      const session = this.createSession(sessionId, child, socketDirectory, socketTokenPath)
      this.sessions.set(sessionId, session)
      child.off('error', ignoreUnownedChildError)
      return { sessionId, socketPath, socketToken }
    } catch (error) {
      try {
        child?.kill('SIGKILL')
      } catch {}
      if (socketDirectory) {
        this.removeSocketDirectory(socketDirectory)
      }
      throw new RuntimeClientError(
        'accessibility_error',
        `native macOS helper app failed to start: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  claim(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.terminating) {
      throw new RuntimeClientError(
        'accessibility_error',
        'native macOS helper session is no longer active'
      )
    }
    this.deps.clearTimer(session.claimTimer)
    this.deps.rmSync(session.socketTokenPath, { force: true })
  }

  release(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.terminating) {
      return
    }
    this.beginTermination(session)
  }

  shutdown(): void {
    for (const session of this.sessions.values()) {
      session.terminating = true
      this.deps.clearTimer(session.claimTimer)
      if (session.forceKillTimer) {
        this.deps.clearTimer(session.forceKillTimer)
        session.forceKillTimer = null
      }
      this.removeSocketDirectory(session.socketDirectory)
      try {
        session.child.kill('SIGKILL')
      } catch {}
    }
  }

  private createSession(
    id: string,
    child: ChildProcess,
    socketDirectory: string,
    socketTokenPath: string
  ): SupervisedMacOSProviderSession {
    const onError = (error: Error): void => {
      const session = this.sessions.get(id)
      if (!session || session.terminating) {
        return
      }
      this.emitTermination(session, `native macOS helper app failed: ${error.message}`)
      session.terminating = true
      this.deps.clearTimer(session.claimTimer)
      this.removeSocketDirectory(session.socketDirectory)
      // Why: retain ownership until exit even if the signal cannot be delivered.
      try {
        child.kill('SIGKILL')
      } catch {}
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      const session = this.sessions.get(id)
      if (!session) {
        return
      }
      if (!session.terminating) {
        const detail = typeof code === 'number' ? `code ${code}` : `signal ${signal ?? 'unknown'}`
        this.emitTermination(session, `native macOS helper app exited with ${detail}`)
      }
      this.finishSession(session)
    }
    child.on('error', onError)
    child.once('exit', onExit)

    const session = {
      id,
      pid: child.pid!,
      child,
      socketDirectory,
      socketTokenPath,
      claimTimer: null as unknown as NodeJS.Timeout,
      forceKillTimer: null,
      terminating: false,
      cleanupListeners: () => {
        child.off('error', onError)
        child.off('exit', onExit)
        child.off('error', ignoreUnownedChildError)
        child.on('error', ignoreUnownedChildError)
      }
    }
    session.claimTimer = this.deps.setTimer(() => {
      const active = this.sessions.get(id)
      if (!active || active.terminating) {
        return
      }
      this.emitTermination(
        active,
        `native macOS helper app was not claimed within ${MACOS_HELPER_CLAIM_TIMEOUT_MS}ms`
      )
      this.beginTermination(active)
    }, MACOS_HELPER_CLAIM_TIMEOUT_MS)
    return session
  }

  private beginTermination(session: SupervisedMacOSProviderSession): void {
    session.terminating = true
    this.deps.clearTimer(session.claimTimer)
    this.removeSocketDirectory(session.socketDirectory)
    try {
      session.child.kill('SIGTERM')
    } catch {}
    session.forceKillTimer = this.deps.setTimer(() => {
      session.forceKillTimer = null
      try {
        session.child.kill('SIGKILL')
      } catch {}
    }, MACOS_HELPER_FORCE_KILL_GRACE_MS)
  }

  private finishSession(session: SupervisedMacOSProviderSession): void {
    if (this.sessions.get(session.id) !== session) {
      return
    }
    this.sessions.delete(session.id)
    this.deps.clearTimer(session.claimTimer)
    if (session.forceKillTimer) {
      this.deps.clearTimer(session.forceKillTimer)
    }
    session.cleanupListeners()
    this.removeSocketDirectory(session.socketDirectory)
  }

  private emitTermination(session: SupervisedMacOSProviderSession, message: string): void {
    this.emitEvent({
      channel: COMPUTER_PROVIDER_SUPERVISOR_CHANNEL,
      kind: 'event',
      event: 'macos.sessionTerminated',
      sessionId: session.id,
      error: { code: 'accessibility_error', message }
    })
  }

  private removeSocketDirectory(socketDirectory: string): void {
    try {
      this.deps.rmSync(socketDirectory, { recursive: true, force: true })
    } catch {
      // Why: cleanup failure must not prevent signaling or reaping the owned helper PID.
    }
  }
}

function createDefaultDeps(): MacOSNativeProviderSupervisorDeps {
  return {
    resolveExecutablePath: resolveMacOSComputerUseExecutablePath,
    spawn,
    randomUUID,
    mkdtempSync,
    chmodSync,
    writeFileSync,
    rmSync,
    setTimer: setTimeout,
    clearTimer: clearTimeout
  }
}
