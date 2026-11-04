import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { AtomicSnapshotWriter } from '../persistence/atomic-snapshot-writer'
import { parseWorkflowPreset } from '../../shared/workflow/workflow-preset-migration'
import {
  WorkflowDefinitionSchema,
  type WorkflowPreset
} from '../../shared/workflow/workflow-definition-schema'
import { workflowTemplates } from '../../shared/workflow/workflow-templates-team'
import type { WorkflowRun } from '../../shared/workflow/workflow-run-types'
import { isWorkflowJsonRecord } from '../../shared/workflow/workflow-json-record'

const RUN_ID_PATTERN = /^wfr_[A-Za-z0-9-]{8,64}$/
const PRESETS_FILE = 'presets.json'
const FILE_MODE = 0o600
const DIRECTORY_MODE = 0o700

function readJson(path: string): unknown {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return parsed
  } catch (error) {
    if (!(isWorkflowJsonRecord(error) && error.code === 'ENOENT')) {
      console.warn('[workflows] could not read', path, error)
    }
    return undefined
  }
}

/** Runs are re-validated on load: a damaged or hand-edited file must not drive the scheduler. */
function parseStoredRun(raw: unknown): WorkflowRun | null {
  if (
    !isWorkflowJsonRecord(raw) ||
    raw.schemaVersion !== 1 ||
    typeof raw.id !== 'string' ||
    !RUN_ID_PATTERN.test(raw.id) ||
    !isWorkflowJsonRecord(raw.tasks) ||
    !Array.isArray(raw.events) ||
    !Array.isArray(raw.messages) ||
    !WorkflowDefinitionSchema.safeParse(raw.definition).success
  ) {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only this store writes run files, from WorkflowRun values; the executable definition and the containers the scheduler walks are re-validated above.
  return raw as WorkflowRun
}

export class WorkflowStore {
  private readonly presets = new Map<string, WorkflowPreset>()
  private readonly runs = new Map<string, WorkflowRun>()
  private readonly runWriters = new Map<string, AtomicSnapshotWriter>()
  private readonly presetWriter: AtomicSnapshotWriter
  private readonly templates = new Map(workflowTemplates().map((preset) => [preset.id, preset]))

  constructor(private readonly rootDir: string) {
    this.presetWriter = new AtomicSnapshotWriter(() => join(rootDir, PRESETS_FILE), {
      fileMode: FILE_MODE,
      directoryMode: DIRECTORY_MODE
    })
    this.load()
  }

  private runsDir(): string {
    return join(this.rootDir, 'runs')
  }

  private load(): void {
    const stored = readJson(join(this.rootDir, PRESETS_FILE))
    const list: unknown[] =
      isWorkflowJsonRecord(stored) && Array.isArray(stored.presets) ? stored.presets : []
    for (const raw of list) {
      const parsed = parseWorkflowPreset(raw)
      if (parsed.ok && !this.templates.has(parsed.preset.id)) {
        this.presets.set(parsed.preset.id, parsed.preset)
      } else if (!parsed.ok) {
        console.warn('[workflows] skipped an unreadable preset:', parsed.error)
      }
    }
    let files: string[] = []
    try {
      files = readdirSync(this.runsDir()).filter((file) => file.endsWith('.json'))
    } catch {
      files = []
    }
    for (const file of files) {
      const run = parseStoredRun(readJson(join(this.runsDir(), file)))
      if (run && `${run.id}.json` === file) {
        this.runs.set(run.id, run)
      }
    }
  }

  listPresets(): WorkflowPreset[] {
    return [...this.templates.values(), ...this.presets.values()]
  }

  getPreset(id: string): WorkflowPreset | null {
    return this.presets.get(id) ?? this.templates.get(id) ?? null
  }

  isTemplate(id: string): boolean {
    return this.templates.has(id)
  }

  async savePreset(preset: WorkflowPreset): Promise<WorkflowPreset> {
    if (this.templates.has(preset.id)) {
      throw new Error('Shipped templates are read-only. Save a copy under a new id.')
    }
    const saved = { ...preset, template: false }
    this.presets.set(saved.id, saved)
    await this.writePresets()
    return saved
  }

  async deletePreset(id: string): Promise<boolean> {
    if (!this.presets.delete(id)) {
      return false
    }
    await this.writePresets()
    return true
  }

  private writePresets(): Promise<void> {
    return this.presetWriter.write(() =>
      JSON.stringify({ schemaVersion: 1, presets: [...this.presets.values()] }, null, 2)
    )
  }

  listRuns(): WorkflowRun[] {
    return [...this.runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  getRun(id: string): WorkflowRun | null {
    return this.runs.get(id) ?? null
  }

  /** Coalesced atomic write; the in-memory run is the controller's working copy. */
  saveRun(run: WorkflowRun): Promise<void> {
    if (!RUN_ID_PATTERN.test(run.id)) {
      return Promise.reject(new Error(`Refusing to persist run with unsafe id ${run.id}.`))
    }
    this.runs.set(run.id, run)
    let writer = this.runWriters.get(run.id)
    if (!writer) {
      writer = new AtomicSnapshotWriter(() => join(this.runsDir(), `${run.id}.json`), {
        fileMode: FILE_MODE,
        directoryMode: DIRECTORY_MODE
      })
      this.runWriters.set(run.id, writer)
    }
    return writer.write(() => JSON.stringify(run))
  }

  deleteRun(id: string): boolean {
    if (!RUN_ID_PATTERN.test(id) || !this.runs.delete(id)) {
      return false
    }
    this.runWriters.get(id)?.close()
    this.runWriters.delete(id)
    rmSync(join(this.runsDir(), `${id}.json`), { force: true })
    return true
  }

  flushSync(): void {
    this.presetWriter.writeSync(() =>
      JSON.stringify({ schemaVersion: 1, presets: [...this.presets.values()] }, null, 2)
    )
    for (const run of this.runs.values()) {
      this.runWriters.get(run.id)?.writeSync(() => JSON.stringify(run))
    }
  }
}
