import type { ChildProcess } from 'node:child_process'
import type { TuiAgent } from '../../shared/types'
import { buildWikiHeadlessArgs } from './wiki-generation-command'
import { killProcessTree } from './wiki-generation-process'

export type WikiGenerationStatus = { running: boolean; output: string; error?: string }

export type WikiGenerationServiceDeps = {
  // Resolve the agent launch binary (cmd override or TUI_AGENT_CONFIG launchCmd). See wiring notes.
  resolveBinary: (agent: TuiAgent) => string
  // Emit a status snapshot to the renderer (webContents.send('wiki:generationChanged', payload)).
  emitChanged: (payload: { worktreeId: string } & WikiGenerationStatus & { done?: boolean }) => void
  // Injected for tests; defaults to the real spawn wrapper in production.
  spawnAgent: (input: {
    binary: string
    args: string[]
    cwd: string
    prompt: string
    promptViaStdin: boolean
  }) => ChildProcess
  now: () => number
}

const MAX_OUTPUT_TAIL = 64 * 1024
// Why: coalesce emitChanged so a chatty child process doesn't flood the
// renderer with an IPC message per stdout chunk.
const WIKI_GENERATION_EMIT_INTERVAL_MS = 200

type GenerationRecord = {
  status: 'running' | 'error'
  output: string
  error?: string
  startedAt: number
  canceled?: boolean
  lastEmitAt?: number
}

// Why: owns the wiki-generation child process + per-worktree state in the main
// process so it survives renderer unmount/remount (sidebar tab switches).
export class WikiGenerationService {
  private readonly records = new Map<string, GenerationRecord>()
  private readonly children = new Map<string, ChildProcess>()

  constructor(private readonly deps: WikiGenerationServiceDeps) {}

  start(input: {
    worktreeId: string
    cwd: string
    agent: TuiAgent
    prompt: string
  }): { ok: true } | { ok: false; error: string } {
    if (this.records.get(input.worktreeId)?.status === 'running') {
      return { ok: true } // idempotent: already generating
    }
    const headless = buildWikiHeadlessArgs(input.agent)
    if (!headless) {
      return {
        ok: false,
        error: `Agent "${input.agent}" does not support background wiki generation.`
      }
    }
    const binary = this.deps.resolveBinary(input.agent)
    this.records.set(input.worktreeId, {
      status: 'running',
      output: '',
      startedAt: this.deps.now()
    })
    const child = this.deps.spawnAgent({
      binary,
      args: headless.args,
      cwd: input.cwd,
      prompt: input.prompt,
      promptViaStdin: headless.promptViaStdin
    })
    this.children.set(input.worktreeId, child)
    const append = (chunk: Buffer | string): void => {
      const record = this.records.get(input.worktreeId)
      if (!record) {
        return
      }
      record.output = (record.output + chunk.toString()).slice(-MAX_OUTPUT_TAIL)
      const now = this.deps.now()
      if (now - (record.lastEmitAt ?? 0) >= WIKI_GENERATION_EMIT_INTERVAL_MS) {
        record.lastEmitAt = now
        this.deps.emitChanged({
          worktreeId: input.worktreeId,
          running: true,
          output: record.output
        })
      }
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.on('error', (err) => this.finish(input.worktreeId, { failed: true, error: err.message }))
    child.on('close', (code) =>
      this.finish(input.worktreeId, {
        failed: code !== 0,
        error: code !== 0 ? `Generation exited with code ${code}.` : undefined
      })
    )
    return { ok: true }
  }

  private finish(worktreeId: string, result: { failed: boolean; error?: string }): void {
    this.children.delete(worktreeId)
    if (this.records.get(worktreeId)?.canceled) {
      this.records.delete(worktreeId)
      this.deps.emitChanged({ worktreeId, running: false, output: '', done: true })
      return
    }
    const record = this.records.get(worktreeId)
    const output = record?.output ?? ''
    if (result.failed) {
      this.records.set(worktreeId, {
        status: 'error',
        output,
        error: result.error,
        startedAt: record?.startedAt ?? this.deps.now()
      })
      this.deps.emitChanged({ worktreeId, running: false, output, error: result.error })
    } else {
      this.records.delete(worktreeId)
      this.deps.emitChanged({ worktreeId, running: false, output, done: true })
    }
  }

  getStatus(worktreeId: string): WikiGenerationStatus | null {
    const record = this.records.get(worktreeId)
    if (!record) {
      return null
    }
    return { running: record.status === 'running', output: record.output, error: record.error }
  }

  cancel(worktreeId: string): void {
    const child = this.children.get(worktreeId)
    if (!child) {
      this.records.delete(worktreeId)
      return
    }
    const record = this.records.get(worktreeId)
    if (record) {
      record.canceled = true
    }
    killProcessTree(child)
  }
}
