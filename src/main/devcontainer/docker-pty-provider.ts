/**
 * PTY provider that runs the shell/agent *inside* a devcontainer via
 * `docker exec`, implementing the same {@link IPtyProvider} contract as the
 * local and SSH providers so the dispatch layer routes to it transparently.
 *
 * Design (hybrid model): Orca manages git/files host-side on the bind mount;
 * only the terminal runs in the container. So this provider is a thin node-pty
 * wrapper around `docker exec` — the host process is the docker client, and its
 * child (the in-container shell) is what the user interacts with.
 *
 * Container id is resolved lazily per spawn (`resolveContainerId`) because a
 * recreated devcontainer gets a new id; the host is keyed by something stable
 * upstream. The worktree cwd is host→container translated before `-w`.
 *
 * Not yet implemented (v1): session serialize/revive (no reattach across app
 * restart), in-container live cwd/foreground reporting, and flow-control acks.
 * These degrade gracefully rather than block a working terminal.
 */
import * as pty from 'node-pty'
import type { IPtyProvider, PtySpawnOptions, PtySpawnResult } from '../providers/types'
import { buildDockerExecArgs } from './docker-exec-command'

type PtySpawnFn = (file: string, args: string[], options: pty.IPtyForkOptions) => pty.IPty

export type DockerPtyProviderConfig = {
  /** Resolve the current container id for this host (recreate-safe). */
  resolveContainerId: () => Promise<string>
  /** Translate a host worktree path to its in-container path (null if unmapped). */
  hostToContainerCwd: (hostPath: string) => string | null
  /** Shell to launch inside the container. Defaults to `bash`. */
  shell?: string
  /** Env var NAMES forwarded into the container via `-e NAME` (values from spawn env). */
  forwardEnv?: readonly string[]
  /** Full environment for the spawned docker client process (incl. forwarded secret values). */
  resolveSpawnEnv?: () => Record<string, string>
  /** Injectable spawn for tests; defaults to node-pty. */
  ptySpawn?: PtySpawnFn
}

type DataPayload = { id: string; data: string }
type ExitPayload = { id: string; code: number }

type Session = {
  proc: pty.IPty
  /** In-container cwd at spawn; best-effort answer for getCwd/getInitialCwd. */
  initialCwd: string
}

let ptyCounter = 0
const DEFAULT_TERM = 'xterm-256color'

export class DockerPtyProvider implements IPtyProvider {
  private readonly sessions = new Map<string, Session>()
  private readonly dataListeners = new Set<(payload: DataPayload) => void>()
  private readonly exitListeners = new Set<(payload: ExitPayload) => void>()

  constructor(private readonly config: DockerPtyProviderConfig) {}

  async spawn(opts: PtySpawnOptions): Promise<PtySpawnResult> {
    const containerId = await this.config.resolveContainerId()
    const shell = this.config.shell ?? 'bash'
    const containerCwd = opts.cwd ? this.config.hostToContainerCwd(opts.cwd) : null
    const term = opts.env?.TERM ?? DEFAULT_TERM

    const args = buildDockerExecArgs({
      containerId,
      shell,
      containerCwd,
      interactive: true,
      forwardEnv: this.config.forwardEnv,
      // TERM is non-secret and must reach the container for correct rendering.
      literalEnv: { TERM: term }
    })

    const spawnFn = this.config.ptySpawn ?? pty.spawn
    const env = this.config.resolveSpawnEnv?.() ?? (process.env as Record<string, string>)
    const proc = spawnFn('docker', args, {
      name: term,
      cols: opts.cols,
      rows: opts.rows,
      // The docker *client* runs on the host; its own cwd is irrelevant to the
      // in-container shell, so leave it at the process default.
      cwd: process.cwd(),
      env
    })

    const id = `dpty-${(ptyCounter += 1)}`
    const session: Session = { proc, initialCwd: containerCwd ?? '' }
    this.sessions.set(id, session)

    proc.onData((data) => {
      for (const listener of this.dataListeners) {
        listener({ id, data })
      }
    })
    proc.onExit(({ exitCode }) => {
      this.sessions.delete(id)
      for (const listener of this.exitListeners) {
        listener({ id, code: exitCode })
      }
    })

    return { id, pid: proc.pid }
  }

  // No cross-restart reattach in v1; a fresh terminal always spawns anew.
  async attach(): Promise<void> {}

  hasPty(id: string): boolean {
    return this.sessions.has(id)
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.proc.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    try {
      this.sessions.get(id)?.proc.resize(cols, rows)
    } catch {
      // node-pty rejects resize during teardown; ignore — the PTY is going away.
    }
  }

  async shutdown(id: string, _opts: { immediate?: boolean; keepHistory?: boolean }): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) {
      return
    }
    this.sessions.delete(id)
    try {
      session.proc.kill()
    } catch {
      // Already dead.
    }
  }

  async sendSignal(id: string, signal: string): Promise<void> {
    try {
      this.sessions.get(id)?.proc.kill(signal)
    } catch {
      // Process may already be gone.
    }
  }

  async getCwd(id: string): Promise<string> {
    // Live in-container cwd isn't readable from the host; report the spawn cwd.
    return this.sessions.get(id)?.initialCwd ?? ''
  }

  async getInitialCwd(id: string): Promise<string> {
    return this.sessions.get(id)?.initialCwd ?? ''
  }

  async clearBuffer(): Promise<void> {}

  acknowledgeDataEvent(): void {}

  async hasChildProcesses(): Promise<boolean> {
    return false
  }

  async getForegroundProcess(): Promise<string | null> {
    return null
  }

  async serialize(): Promise<string> {
    return ''
  }

  async revive(): Promise<void> {}

  async listProcesses(): Promise<{ id: string; cwd: string; title: string }[]> {
    return Array.from(this.sessions.entries()).map(([id, session]) => ({
      id,
      cwd: session.initialCwd,
      title: session.proc.process
    }))
  }

  async getDefaultShell(): Promise<string> {
    return this.config.shell ?? 'bash'
  }

  async getProfiles(): Promise<{ name: string; path: string }[]> {
    return []
  }

  onData(callback: (payload: DataPayload) => void): () => void {
    this.dataListeners.add(callback)
    return () => this.dataListeners.delete(callback)
  }

  // Replay only applies to relay/daemon reattach; devcontainer sessions never replay.
  onReplay(): () => void {
    return () => {}
  }

  onExit(callback: (payload: ExitPayload) => void): () => void {
    this.exitListeners.add(callback)
    return () => this.exitListeners.delete(callback)
  }
}
