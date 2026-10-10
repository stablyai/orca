import { randomUUID } from 'node:crypto'
import { executeCodexMaintenanceProcess } from './codex-maintenance-process'
import { codexMaintenanceDiagnostic } from './codex-maintenance-diagnostic'
import { spawnProcess } from '@orca/process-host'
import type { PipedProcessSpec, ProcessSpec } from '@orca/process-host/process-spec'
import { clampUtf8TextTail } from '../../shared/utf8-byte-limits'
import {
  CODEX_INSTALL_COMMAND,
  type CodexMaintenanceJob,
  type CodexMaintenanceState
} from '../../shared/codex-cli-maintenance'
import { invalidateCodexCliInstallation } from './codex-cli-installation'
import {
  resolveCodexMaintenanceCommand,
  type CodexMaintenanceContext
} from './codex-maintenance-command'

type JobEntry = { job: CodexMaintenanceJob; finishedAt: number | null }

export class CodexMaintenanceRunner {
  private readonly jobs = new Map<string, JobEntry>()
  private active: Promise<CodexMaintenanceState> | null = null
  private revision = 0
  private unsettledProcess: (() => boolean) | null = null

  constructor(
    private readonly deps = {
      resolve: (context: CodexMaintenanceContext) => resolveCodexMaintenanceCommand(context),
      spawn: (spec: PipedProcessSpec) => spawnProcess(spec),
      invalidate: () => invalidateCodexCliInstallation()
    }
  ) {}

  async status(
    jobId?: string,
    context: CodexMaintenanceContext = {}
  ): Promise<CodexMaintenanceState> {
    this.prune()
    const revision = this.revision
    let current = await this.deps.resolve(context)
    if (revision !== this.revision) {
      current = await this.deps.resolve(context)
    }
    const latest = [...this.jobs.values()].at(-1)?.job ?? null
    const job = jobId ? (this.jobs.get(jobId)?.job ?? null) : latest
    return {
      installation: current.installation,
      evidence: current.evidence,
      currentJob: latest ? { id: latest.id, phase: latest.phase } : null,
      canRun: Boolean(current.spec) && !this.unsettledProcess?.(),
      job
    }
  }

  start(context: CodexMaintenanceContext = {}): Promise<CodexMaintenanceState> {
    if (this.active) {
      return this.active
    }
    if (this.unsettledProcess?.()) {
      return Promise.reject(new Error('The previous Codex install is still live.'))
    }
    this.unsettledProcess = null
    // Acquire before resolving the binary; simultaneous surfaces share the same job.
    this.revision += 1
    this.active = this.begin(context).catch((error: unknown) => {
      this.active = null
      throw error
    })
    return this.active
  }

  private async begin(context: CodexMaintenanceContext): Promise<CodexMaintenanceState> {
    const resolved = await this.deps.resolve(context)
    if (!resolved.spec) {
      throw new Error('Codex does not need installing.')
    }
    const job: CodexMaintenanceJob = {
      id: randomUUID(),
      phase: 'queued',
      output: `$ ${CODEX_INSTALL_COMMAND}\n`,
      exitCode: null,
      error: null
    }
    this.jobs.set(job.id, { job, finishedAt: null })
    void this.execute(job, resolved.spec, context)
    return {
      installation: resolved.installation,
      evidence: resolved.evidence,
      currentJob: { id: job.id, phase: job.phase },
      canRun: true,
      job: { ...job }
    }
  }

  private async execute(
    job: CodexMaintenanceJob,
    spec: ProcessSpec,
    context: CodexMaintenanceContext
  ): Promise<void> {
    const append = (chunk: Buffer | string): void => {
      job.output = clampUtf8TextTail(job.output + chunk.toString(), 128 * 1024).text
    }
    try {
      job.phase = 'running'
      const result = await executeCodexMaintenanceProcess(spec, append, {
        spawn: this.deps.spawn
      })
      job.exitCode = result.code
      job.error = result.error
      job.termination = result.termination
      if (result.termination === 'unverifiable') {
        this.unsettledProcess = result.isLive
      }
    } catch (error) {
      job.error = error instanceof Error ? error.message : String(error)
    } finally {
      // Spawn, timeout and supervision errors may never reach the command's stderr.
      if (job.error) {
        append(`\n${codexMaintenanceDiagnostic(job.error)}\n`)
      }
      this.revision += 1
      this.deps.invalidate()
      try {
        await this.deps.resolve(context)
      } catch (error) {
        append(
          `\n${codexMaintenanceDiagnostic(error instanceof Error ? error.message : String(error))}\n`
        )
      }
      job.phase = 'completed'
      const entry = this.jobs.get(job.id)
      if (entry) {
        entry.finishedAt = Date.now()
      }
      this.active = null
      this.prune()
    }
  }

  private prune(): void {
    for (const [id, entry] of this.jobs) {
      if (
        entry.finishedAt !== null &&
        (Date.now() - entry.finishedAt > 30 * 60_000 || this.jobs.size > 16)
      ) {
        this.jobs.delete(id)
      }
    }
  }
}

export const codexMaintenanceRunner = new CodexMaintenanceRunner()
