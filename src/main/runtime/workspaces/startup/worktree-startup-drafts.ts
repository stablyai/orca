import { SETUP_WAIT_GATE_MAX_MS } from '../../../../shared/agent-launch/startup/setup-wait-output-gate'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import { folderIdOfSelector } from '../../../../shared/workspace/identity/workspace-scope'
import type {
  AvailableStartupDraft,
  StartupDraftOutcome,
  StartupDraftReceipt
} from '../../../../shared/worktree/creation/startup-draft-receipt'
import type { Worktree } from '../../../../shared/worktree/types'
import { writeFileAtomically } from '../../../filesystem/atomic-file-publication'
import type { RuntimeStore } from '../../construction/runtime-store-contract'

type StoredDraft = AvailableStartupDraft & { instanceId: string; text: string }
type DraftEntry = Omit<StoredDraft, 'text'> & { file: string }
const STARTUP_DRAFT_DIRECTORY = 'worktree-startup-drafts'

export function startupDraftPath(profile: string, worktreeId: string, instanceId: string): string {
  const key = createHash('sha256')
    .update(JSON.stringify([worktreeId, instanceId]))
    .digest('hex')
  return join(profile, STARTUP_DRAFT_DIRECTORY, `${key}.json`)
}

export function writeStoredStartupDraft(file: string, draft: StoredDraft): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileAtomically(file, JSON.stringify(draft), { mode: 0o600 })
}

type PendingDraft = {
  ptyId?: string
  unclaimedDeadline: ReturnType<typeof setTimeout>
  outcome: Promise<StartupDraftOutcome>
  finish: (outcome: StartupDraftOutcome) => void
}

export class WorktreeStartupDrafts {
  private readonly entries = new Map<string, DraftEntry>()
  private readonly pending = new Map<string, PendingDraft>()
  // A fast wrapper can finish before its create reply reaches the window.
  private readonly settled = new Map<string, StartupDraftOutcome>()
  private loaded = false

  constructor(
    private readonly store: RuntimeStore,
    private readonly notify: (drafts: AvailableStartupDraft[]) => void
  ) {}

  prepare(worktree: Worktree, text: unknown): StartupDraftReceipt | undefined {
    const profile = this.store.getProfileStorageDirectory?.()
    if (typeof text !== 'string' || !text.trim() || !profile) {
      return undefined
    }
    const instanceId = worktree.instanceId ?? folderIdOfSelector(worktree.id)
    if (!instanceId) {
      return undefined
    }
    this.load()
    const id = randomUUID()
    const file = startupDraftPath(profile, worktree.id, instanceId)
    const entry: DraftEntry = { id, worktreeId: worktree.id, instanceId, outcome: 'unknown', file }
    const previous = this.entries.get(worktree.id)
    this.write(entry, text)
    const { promise, resolve } = Promise.withResolvers<StartupDraftOutcome>()
    const receipt = { id, worktreeId: worktree.id }
    const unclaimedDeadline = setTimeout(
      () => this.settle(receipt, 'unknown'),
      SETUP_WAIT_GATE_MAX_MS
    )
    unclaimedDeadline.unref()
    this.pending.set(id, { outcome: promise, finish: resolve, unclaimedDeadline })
    this.entries.set(worktree.id, entry)
    if (previous) {
      this.finish(previous.id, 'cleared')
      this.publish()
    }
    return receipt
  }

  snapshot(): AvailableStartupDraft[] {
    this.load()
    return [...this.entries.values()].flatMap(({ id, worktreeId, instanceId, outcome }) =>
      this.pending.has(id) || this.instanceId(worktreeId) !== instanceId
        ? []
        : [{ id, worktreeId, outcome }]
    )
  }

  read(receipt: StartupDraftReceipt): string | null {
    const entry = this.current(receipt)
    return entry && !this.pending.has(entry.id) ? this.readText(entry) : null
  }

  dismiss(receipt: StartupDraftReceipt): boolean {
    const entry = this.current(receipt)
    if (!entry || this.pending.has(entry.id)) {
      return false
    }
    this.remove(entry, 'cleared')
    return true
  }

  wait(receipt: StartupDraftReceipt): Promise<StartupDraftOutcome> | StartupDraftOutcome {
    const entry = this.current(receipt)
    return (
      (entry && this.pending.get(entry.id)?.outcome) ??
      entry?.outcome ??
      this.settled.get(receipt.id) ??
      'unknown'
    )
  }

  claimGate(worktreeId: string, ptyId: string): StartupDraftReceipt | undefined {
    const entry = this.entries.get(worktreeId)
    const pending = entry && this.pending.get(entry.id)
    if (
      !entry ||
      !pending ||
      (pending.ptyId && pending.ptyId !== ptyId) ||
      this.instanceId(worktreeId) !== entry.instanceId
    ) {
      return undefined
    }
    pending.ptyId = ptyId
    clearTimeout(pending.unclaimedDeadline)
    return { id: entry.id, worktreeId }
  }

  recoveryForLaunch(worktreeId: string): StartupDraftReceipt | undefined {
    this.load()
    const entry = this.entries.get(worktreeId)
    if (!entry || this.pending.has(entry.id) || this.instanceId(worktreeId) !== entry.instanceId) {
      return undefined
    }
    return { id: entry.id, worktreeId }
  }

  releaseUnclaimed(receipt: StartupDraftReceipt): void {
    if (!this.pending.get(receipt.id)?.ptyId) {
      this.settle(receipt, 'cleared')
    }
  }

  settle(receipt: StartupDraftReceipt, outcome: StartupDraftOutcome): void {
    const entry = this.current(receipt)
    if (!this.pending.has(receipt.id)) {
      return
    }
    if (!entry) {
      this.finish(receipt.id, 'unknown')
      return
    }
    try {
      this.settleEntry(entry, outcome)
    } catch {
      this.finish(entry.id, 'unknown')
      this.publish()
      console.warn('[worktree-create] could not settle the startup draft')
    }
  }

  private settleEntry(entry: DraftEntry, outcome: StartupDraftOutcome): void {
    if (outcome === 'started' || outcome === 'cleared') {
      this.remove(entry, outcome)
      return
    }
    if (outcome !== entry.outcome) {
      const text = this.readText(entry)
      if (text !== null) {
        this.write({ ...entry, outcome }, text)
      }
      entry.outcome = outcome
    }
    this.finish(entry.id, outcome)
    this.publish()
  }

  private get directory(): string | undefined {
    const profile = this.store.getProfileStorageDirectory?.()
    return profile ? join(profile, STARTUP_DRAFT_DIRECTORY) : undefined
  }

  private instanceId(worktreeId: string): string | undefined {
    const folderId = folderIdOfSelector(worktreeId)
    return folderId
      ? this.store.getFolderWorkspace?.(folderId)?.id
      : this.store.getWorktreeMetaForHost?.(worktreeId, LOCAL_EXECUTION_HOST_ID)?.instanceId
  }

  private current(receipt: StartupDraftReceipt): DraftEntry | undefined {
    this.load()
    const entry = this.entries.get(receipt.worktreeId)
    return entry?.id === receipt.id && this.instanceId(entry.worktreeId) === entry.instanceId
      ? entry
      : undefined
  }

  private load(): void {
    if (this.loaded || !this.directory) {
      return
    }
    this.loaded = true
    try {
      for (const name of readdirSync(this.directory)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) {
          continue
        }
        const file = join(this.directory, name)
        const draft = this.readFile(file)
        if (draft && this.instanceId(draft.worktreeId) === draft.instanceId) {
          const { text: _text, ...entry } = draft
          this.entries.set(entry.worktreeId, { ...entry, file })
        }
      }
    } catch (error) {
      if (!isDefinitiveAbsence(error)) {
        console.warn('[worktree-create] could not load startup drafts')
      }
    }
  }

  private readFile(file: string): StoredDraft | null {
    try {
      const draft = JSON.parse(readFileSync(file, 'utf8')) as Partial<StoredDraft> | null
      return draft &&
        typeof draft.id === 'string' &&
        typeof draft.worktreeId === 'string' &&
        typeof draft.instanceId === 'string' &&
        typeof draft.text === 'string' &&
        (draft.outcome === 'unknown' || draft.outcome === 'not-delivered')
        ? (draft as StoredDraft)
        : null
    } catch {
      return null
    }
  }

  private readText(entry: DraftEntry): string | null {
    const draft = this.readFile(entry.file)
    return draft?.id === entry.id ? draft.text : null
  }

  private write({ file, ...entry }: DraftEntry, text: string): void {
    writeStoredStartupDraft(file, { ...entry, text })
  }

  private remove(entry: DraftEntry, outcome: StartupDraftOutcome): void {
    rmSync(entry.file, { force: true })
    this.entries.delete(entry.worktreeId)
    this.finish(entry.id, outcome)
    this.publish()
  }

  private finish(id: string, outcome: StartupDraftOutcome): void {
    const pending = this.pending.get(id)
    if (pending) {
      clearTimeout(pending.unclaimedDeadline)
      pending.finish(outcome)
    }
    this.pending.delete(id)
    this.settled.set(id, outcome)
    if (this.settled.size > 128) {
      const oldest = this.settled.keys().next()
      if (!oldest.done) {
        this.settled.delete(oldest.value)
      }
    }
  }

  private publish(): void {
    this.notify(this.snapshot())
  }
}
