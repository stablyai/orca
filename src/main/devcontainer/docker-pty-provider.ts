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

  /** Start a shell inside the container via `docker exec` and stream its IO. */
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

  /** No cross-restart reattach in v1; a fresh terminal always spawns anew. */
  async attach(): Promise<void> {}

  /** Whether a live PTY session exists for `id`. */
  hasPty(id: string): boolean {
    return this.sessions.has(id)
  }

  /** Write input to the container shell's stdin. */
  write(id: string, data: string): void {
    this.sessions.get(id)?.proc.write(data)
  }

  /** Resize the PTY; ignored if the process is already tearing down. */
  resize(id: string, cols: number, rows: number): void {
    try {
      this.sessions.get(id)?.proc.resize(cols, rows)
    } catch {
      // node-pty rejects resize during teardown; ignore — the PTY is going away.
    }
  }

  /** Kill the `docker exec` process and drop its session. */
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

  /** Send a signal to the container shell process. */
  async sendSignal(id: string, signal: string): Promise<void> {
    try {
      this.sessions.get(id)?.proc.kill(signal)
    } catch {
      // Process may already be gone.
    }
  }

  /** Best-effort cwd: the live in-container cwd isn't readable from the host. */
  async getCwd(id: string): Promise<string> {
    return this.sessions.get(id)?.initialCwd ?? ''
  }

  /** The in-container cwd the session was spawned in. */
  async getInitialCwd(id: string): Promise<string> {
    return this.sessions.get(id)?.initialCwd ?? ''
  }

  /** No-op: scrollback clearing is handled client-side for docker sessions. */
  async clearBuffer(): Promise<void> {}

  /** No-op: flow-control acks are not implemented for docker sessions. */
  acknowledgeDataEvent(): void {}

  /** Child-process inspection isn't available across `docker exec`; report none. */
  async hasChildProcesses(): Promise<boolean> {
    return false
  }

  /** Foreground-process inspection isn't available across `docker exec`. */
  async getForegroundProcess(): Promise<string | null> {
    return null
  }

  /** No-op: devcontainer sessions are not serialized across app restarts in v1. */
  async serialize(): Promise<string> {
    return ''
  }

  /** No-op counterpart to {@link serialize}. */
  async revive(): Promise<void> {}

  /** List live sessions as `{ id, cwd, title }` triples. */
  async listProcesses(): Promise<{ id: string; cwd: string; title: string }[]> {
    return Array.from(this.sessions.entries()).map(([id, session]) => ({
      id,
      cwd: session.initialCwd,
      title: session.proc.process
    }))
  }

  /** The shell launched inside the container (defaults to `bash`). */
  async getDefaultShell(): Promise<string> {
    return this.config.shell ?? 'bash'
  }

  /** No selectable shell profiles for docker sessions. */
  async getProfiles(): Promise<{ name: string; path: string }[]> {
    return []
  }

  /** Subscribe to terminal output; returns an unsubscribe function. */
  onData(callback: (payload: DataPayload) => void): () => void {
    this.dataListeners.add(callback)
    return () => this.dataListeners.delete(callback)
  }

  /** Replay only applies to relay/daemon reattach; devcontainer sessions never replay. */
  onReplay(): () => void {
    return () => {}
  }

  /** Subscribe to PTY exit; returns an unsubscribe function. */
  onExit(callback: (payload: ExitPayload) => void): () => void {
    this.exitListeners.add(callback)
    return () => this.exitListeners.delete(callback)
  }
}
