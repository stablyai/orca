import { WorkspaceServerSubscriptions } from './workspace-server-subscriptions'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import {
  WorkspaceServerStartAdmission,
  type WorkspaceServerStartPermit
} from './workspace-server-start-admission'
import {
  type WorkspaceServerRun as Run,
  isWorkspaceServerActive as active,
  retireInactiveServerRun,
  stopServerRuns,
  forceCloseServerRuns
} from './workspace-server-runs'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { stripVTControlCharacters } from 'node:util'
import { spawnProcess } from '@orca/process-host'
import type { PipedChildProcess, PipedProcessSpec } from '@orca/process-host/process-spec'
import {
  signalProcessTree,
  forceTerminateProcessTree
} from '@orca/process-host/process-tree-termination'
import { advertisedUrlWatcher } from '../ports/advertised-url-watcher'
import {
  WORKSPACE_SERVER_OUTPUT_SOURCE_PREFIX,
  trimServerLogs,
  serverLogLevel,
  type WorkspaceServerFrame,
  type WorkspaceServerLogLine,
  type WorkspaceServerSnapshot
} from '../../shared/workspace-server-process'

export class WorkspaceServerProcessManager {
  private readonly runs = new Map<string, Run>()
  private readonly listeners = new WorkspaceServerSubscriptions()
  private readonly admission = new WorkspaceServerStartAdmission()
  private seq = 0
  private closing = false
  constructor(
    private readonly spawn: (spec: PipedProcessSpec) => PipedChildProcess = spawnProcess
  ) {}
  beginStart(): WorkspaceServerStartPermit {
    return this.admission.beginStart()
  }
  beginWorktreeRemoval(worktreeId: string): () => void {
    return this.admission.beginWorktreeRemoval(worktreeId)
  }
  beginProjectRemoval(repoId: string): () => void {
    return this.admission.beginProjectRemoval(repoId)
  }
  async stopProject(repoId: string): Promise<void> {
    await stopServerRuns(
      this.runs.values(),
      (run) => getRepoIdFromWorktreeId(run.info.worktreeId) === repoId,
      this.stop.bind(this)
    )
  }
  hasActiveServers(): boolean {
    return (
      this.admission.pending ||
      [...this.runs.values()].some((run) => active(run) || Boolean(run.stopPromise))
    )
  }
  async stopWorktree(worktreeId: string): Promise<void> {
    await stopServerRuns(
      this.runs.values(),
      (run) => run.info.worktreeId === worktreeId,
      this.stop.bind(this)
    )
  }

  private key(worktreeId: string, port: number): string {
    return JSON.stringify([worktreeId, port])
  }
  private snapshot(run: Run): WorkspaceServerSnapshot {
    return { ...run.info, active: active(run), logs: [...run.logs] }
  }
  private flush(run: Run, reset = false): void {
    if (this.runs.get(this.key(run.info.worktreeId, run.info.port)) !== run) {
      return
    }
    clearTimeout(run.timer)
    run.timer = undefined
    const lines = run.pending
    run.pending = []
    this.listeners.emit(run.info.worktreeId, {
      type: 'update',
      info: { ...run.info, active: active(run) },
      lines,
      reset
    })
  }
  private append(run: Run, source: WorkspaceServerLogLine['source'], text: string): void {
    const line = {
      seq: ++this.seq,
      time: Date.now(),
      source,
      level: serverLogLevel(text),
      text: stripVTControlCharacters(text).slice(-8192)
    }
    line.level = serverLogLevel(line.text)
    if (line.level === 'error') {
      run.info.errorCount += 1
    }
    run.logs = trimServerLogs([...run.logs, line])
    if (!this.listeners.has(run.info.worktreeId)) {
      return
    }
    run.pending = trimServerLogs([...run.pending, line])
    run.timer ??= setTimeout(() => this.flush(run), 100)
  }
  start(
    args: { worktreeId: string; port: number; name: string },
    spec: PipedProcessSpec,
    permit?: WorkspaceServerStartPermit
  ): WorkspaceServerSnapshot {
    const key = this.key(args.worktreeId, args.port)
    if (this.closing) {
      throw new Error('Server host is shutting down.')
    }
    permit?.validate(args.worktreeId)
    this.admission.assertAvailable(args.worktreeId)
    const previous = this.runs.get(key)
    if (previous && (active(previous) || previous.stopPromise)) {
      throw new Error('This server is already running.')
    }
    if (!previous && this.runs.size >= 64) {
      const run = retireInactiveServerRun(this.runs)
      this.listeners.emit(run.info.worktreeId, {
        type: 'snapshot',
        runs: [...this.runs.values()]
          .filter((entry) => entry.info.worktreeId === run.info.worktreeId)
          .map((entry) => this.snapshot(entry))
      })
    }
    if (previous) {
      clearTimeout(previous.timer)
    }
    let finish = () => {}
    const done = new Promise<void>((resolve) => {
      finish = resolve
    })
    const run: Run = {
      info: {
        id: randomUUID(),
        ...args,
        status: 'starting',
        exitCode: null,
        errorCount: 0,
        startedAt: Date.now()
      },
      child: null,
      logs: [],
      pending: [],
      stopped: false,
      done,
      finish
    }
    this.runs.set(key, run)
    const sourceId = WORKSPACE_SERVER_OUTPUT_SOURCE_PREFIX + run.info.id
    advertisedUrlWatcher.bindPty(sourceId, args.worktreeId)
    this.flush(run, true)
    try {
      const child = this.spawn({ ...spec, detached: process.platform !== 'win32' })
      run.child = child
      run.info.pid = child.pid
      const buffers = { stdout: '', stderr: '' }
      const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }
      const ingest = (source: 'stdout' | 'stderr', chunk: Buffer | string) => {
        const text = typeof chunk === 'string' ? chunk : decoders[source].write(chunk)
        advertisedUrlWatcher.ingest(sourceId, text)
        const lines = (buffers[source] + text).split(/\r\n|[\n\r]/)
        buffers[source] = (lines.pop() ?? '').slice(-8192)
        for (const line of lines) {
          if (line) {
            this.append(run, source, line)
          }
        }
      }
      child.stdout.on('data', (chunk: Buffer | string) => ingest('stdout', chunk))
      child.stderr.on('data', (chunk: Buffer | string) => ingest('stderr', chunk))
      child.stdout.on('error', (error) => this.append(run, 'system', `Error: ${error.message}`))
      child.stderr.on('error', (error) => this.append(run, 'system', `Error: ${error.message}`))
      child.stdin.on('error', () => {})
      child.stdin.end()
      child.once('spawn', () => {
        if (!run.stopped) {
          run.info.status = 'running'
        }
        this.flush(run)
      })
      child.once('error', (error) => {
        this.append(run, 'system', `Error: ${error.message}`)
        run.info.status = 'error'
        this.flush(run)
      })
      child.once('close', (code, signal) => {
        for (const source of ['stdout', 'stderr'] as const) {
          const tail = buffers[source] + decoders[source].end()
          if (tail) {
            this.append(run, source, tail)
          }
        }
        run.child = null
        run.info.exitCode = code
        if (run.stopped) {
          run.info.status = 'stopped'
        } else if (code !== 0 || signal || run.info.status === 'error') {
          run.info.status = 'error'
          this.append(run, 'system', `Error: process exited (${code ?? signal ?? 'unknown'})`)
        } else {
          run.info.status = 'stopped'
        }
        advertisedUrlWatcher.unbindPty(sourceId)
        this.flush(run)
        run.finish()
      })
    } catch (error) {
      run.info.status = 'error'
      this.append(run, 'system', `Error: ${error instanceof Error ? error.message : String(error)}`)
      advertisedUrlWatcher.unbindPty(sourceId)
      this.flush(run)
      run.finish()
    }
    return this.snapshot(run)
  }
  async stop(worktreeId: string, port: number, runId: string): Promise<WorkspaceServerSnapshot> {
    const run = this.runs.get(this.key(worktreeId, port))
    if (!run || run.info.id !== runId) {
      throw new Error('The server run changed. Refresh and try again.')
    }
    if (run.stopPromise) {
      return run.stopPromise
    }
    if (!run.child) {
      return this.snapshot(run)
    }
    const child = run.child
    run.stopped = true
    run.info.status = 'stopping'
    this.flush(run)
    run.stopPromise = (async () => {
      await signalProcessTree(child, 'SIGTERM')
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        run.done,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 1500)
        })
      ])
      clearTimeout(timer)
      const gone = await forceTerminateProcessTree(child)
      if (!gone) {
        run.child = child
        run.info.status = 'error'
        this.append(run, 'system', 'Error: could not verify process termination')
        this.flush(run)
        throw new Error('Could not verify server termination.')
      }
      await run.done
      run.child = null
      run.info.status = 'stopped'
      this.flush(run)
      return this.snapshot(run)
    })().finally(() => {
      run.stopPromise = undefined
    })
    return run.stopPromise
  }
  subscribe(worktreeId: string, listener: (frame: WorkspaceServerFrame) => void): () => void {
    return this.listeners.subscribe(
      worktreeId,
      listener,
      [...this.runs.values()]
        .filter((run) => run.info.worktreeId === worktreeId)
        .map((run) => this.snapshot(run))
    )
  }
  private beginShutdown(): void {
    this.closing = true
    this.listeners.clear()
    for (const run of this.runs.values()) {
      clearTimeout(run.timer)
      run.timer = undefined
    }
  }
  async forceClose(): Promise<void> {
    this.beginShutdown()
    await forceCloseServerRuns(this.runs.values())
  }
  async close(): Promise<void> {
    this.beginShutdown()
    await stopServerRuns(this.runs.values(), () => true, this.stop.bind(this))
  }
}
