import { createTerminalIdentityProjectionInputs } from './terminal-identity-projection-inputs'
import type { DispatchCreator } from '../../orchestration/db/dispatch-depth'
import type { AgentSessionRecordReader } from '../../orchestration/structured-session-lineage'
import {
  captureStructuredWorkerReadInputs,
  createStructuredWorkerReadContext,
  type StructuredWorkerReadContext
} from '../../structured-worker-authority'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type {
  OrchestrationCompatibilitySshTerminal,
  TerminalHandleRecord
} from '../../runtime-terminal-contracts'
import type {
  RuntimeLeafRecord,
  RuntimePtyWorktreeRecord
} from '../../runtime-terminal-state-records'
import type { PtyPane, PtyPaneOf, PtyPaneSource } from '../surface/pty-pane-query'

type IdentitySources = {
  handles: ReadonlyMap<string, TerminalHandleRecord>
  reverse: ReadonlyMap<string, string>
  leaves: ReadonlyMap<string, RuntimeLeafRecord>
  ptys: ReadonlyMap<string, RuntimePtyWorktreeRecord>
  sshTerminals: ReadonlyMap<string, OrchestrationCompatibilitySshTerminal>
  capturePaneOf: () => PtyPaneOf
}

type OrderedKeys = ReadonlyMap<string, number>
type IndexedKeys = Map<string, Map<string, number>>

function add(index: IndexedKeys, key: string, value: string, order: number): void {
  const bucket = index.get(key) ?? new Map()
  bucket.set(value, order)
  index.set(key, bucket)
}

function ordered(keys: OrderedKeys | undefined): string[] {
  return [...(keys ?? [])].sort((a, b) => a[1] - b[1]).map(([key]) => key)
}

/** Lazy immutable candidate facts, shared only within the existing observed input generation. */
export class TerminalIdentityRawInputs {
  private readonly projections = createTerminalIdentityProjectionInputs()
  captureCallerProjection = this.projections.caller
  captureProjectionRecords = this.projections.records
  private structuredInputs: ReturnType<typeof captureStructuredWorkerReadInputs> | undefined

  openStructured(): StructuredWorkerReadContext {
    this.structuredInputs ??= captureStructuredWorkerReadInputs()
    return createStructuredWorkerReadContext(this.structuredInputs)
  }
  private reverse: IndexedKeys | undefined
  private synthetic: IndexedKeys | undefined
  private leafKeys: Map<string, string[]> | undefined
  private panePtys: IndexedKeys | undefined
  private leafPtys: IndexedKeys | undefined
  private ssh: Map<string, string[]> | undefined
  private paneReader: PtyPaneOf | undefined
  private readonly reverseFacts = new Map<string, { handle: string; order: number }>()
  private handleCount = 0
  private readonly handleFacts = new Map<string, { ptyId: string; order: number }>()

  constructor(private readonly source: IdentitySources) {}

  paneOf(pty: PtyPaneSource): PtyPane {
    this.paneReader ??= this.source.capturePaneOf()
    return this.paneReader(pty)
  }

  get reverseCaptured(): boolean {
    return this.reverse !== undefined
  }
  get reverseSize(): number {
    return this.reverseFacts.size
  }
  get handlesSize(): number {
    return this.handleCount
  }
  get handlesCaptured(): boolean {
    return this.synthetic !== undefined
  }
  reverseFact(ptyId: string) {
    return this.reverseFacts.get(ptyId)
  }
  handleFact(handle: string) {
    return this.handleFacts.get(handle)
  }

  reverseKeys(handle: string): OrderedKeys | undefined {
    if (!this.reverse) {
      this.reverse = new Map()
      for (const [ptyId, mapped] of this.source.reverse) {
        const order = this.reverseFacts.size
        this.reverseFacts.set(ptyId, { handle: mapped, order })
        add(this.reverse, mapped, ptyId, order)
      }
    }
    return this.reverse.get(handle)
  }

  syntheticKeys(ptyId: string): OrderedKeys | undefined {
    if (!this.synthetic) {
      this.synthetic = new Map()
      let order = 0
      for (const [handle, record] of this.source.handles) {
        if (record.ptyId && record.tabId.startsWith('pty:')) {
          this.handleFacts.set(handle, { ptyId: record.ptyId, order })
          add(this.synthetic, record.ptyId, handle, order)
        }
        order++
      }
      this.handleCount = order
    }
    return this.synthetic.get(ptyId)
  }

  leavesForId(leafId: string): Iterable<string> {
    if (!this.leafKeys) {
      this.leafKeys = new Map()
      for (const [key, leaf] of this.source.leaves) {
        const keys = this.leafKeys.get(leaf.leafId) ?? []
        keys.push(key)
        this.leafKeys.set(leaf.leafId, keys)
      }
    }
    return this.leafKeys.get(leafId) ?? []
  }

  ptysForPane(paneKey: string): Iterable<string> {
    if (!this.panePtys) {
      this.panePtys = new Map()
      this.leafPtys = new Map()
      let order = 0
      for (const [ptyId, pty] of this.source.ptys) {
        const pane = this.paneOf(pty).paneKey
        if (pane !== null) {
          add(this.panePtys, pane, ptyId, order)
          const parsed = parsePaneKey(pane)
          if (parsed) {
            add(this.leafPtys, parsed.leafId, ptyId, order)
          }
        }
        order++
      }
    }
    const exact = this.panePtys.get(paneKey)
    const parsed = parsePaneKey(paneKey)
    const suffix = parsed ? this.leafPtys?.get(parsed.leafId) : undefined
    return ordered(new Map([...(exact ?? []), ...(suffix ?? [])]))
  }

  sshAttachmentIds(handle: string): Iterable<string> {
    if (!this.ssh) {
      this.ssh = new Map()
      for (const [id, terminal] of this.source.sshTerminals) {
        const ids = this.ssh.get(terminal.handle) ?? []
        ids.push(id)
        this.ssh.set(terminal.handle, ids)
      }
    }
    return this.ssh.get(handle) ?? []
  }
}

/** Finite owner-read scratch; retained inputs contain raw candidates, never a selected answer. */
export class TerminalIdentityReadContext {
  private structuredContext: StructuredWorkerReadContext | undefined
  private readonly reverseEdits: IndexedKeys = new Map()
  private readonly handleEdits: IndexedKeys = new Map()
  private readonly reverseFacts = new Map<string, { handle: string; order: number } | undefined>()
  private readonly handleFacts = new Map<string, { ptyId: string; order: number } | undefined>()
  private nextReverseOrder: number | undefined
  private nextHandleOrder: number | undefined

  constructor(
    private readonly source: IdentitySources,
    private readonly inputs = new TerminalIdentityRawInputs(source)
  ) {}

  get structured(): StructuredWorkerReadContext {
    return (this.structuredContext ??= this.inputs.openStructured())
  }

  captureCallerProjection = (handle: string, read: () => DispatchCreator) =>
    this.inputs.captureCallerProjection(handle, read)
  paneOf = (pty: PtyPaneSource): PtyPane => this.inputs.paneOf(pty)
  captureProjectionRecords = (read: () => AgentSessionRecordReader | null) =>
    this.inputs.captureProjectionRecords(read)

  leavesForId = (id: string): Iterable<string> => this.inputs.leavesForId(id)
  ptysForPane = (pane: string): Iterable<string> => this.inputs.ptysForPane(pane)
  sshAttachmentIds = (handle: string): Iterable<string> => this.inputs.sshAttachmentIds(handle)
  reversePtyIds = (handle: string): readonly string[] =>
    ordered(this.reverseEdits.get(handle) ?? this.inputs.reverseKeys(handle))
  syntheticHandles = (ptyId: string): Iterable<string> =>
    ordered(this.handleEdits.get(ptyId) ?? this.inputs.syntheticKeys(ptyId))

  changedReverseBinding(ptyId: string): void {
    if (!this.inputs.reverseCaptured) {
      return
    }
    const prior = this.reverseFacts.has(ptyId)
      ? this.reverseFacts.get(ptyId)
      : this.inputs.reverseFact(ptyId)
    const handle = this.source.reverse.get(ptyId)
    if (prior?.handle === handle) {
      return
    }
    if (prior) {
      this.edit(this.reverseEdits, prior.handle, this.inputs.reverseKeys(prior.handle)).delete(
        ptyId
      )
    }
    if (handle !== undefined) {
      this.nextReverseOrder ??= this.inputs.reverseSize
      const order = prior?.order ?? this.nextReverseOrder++
      this.edit(this.reverseEdits, handle, this.inputs.reverseKeys(handle)).set(ptyId, order)
      this.reverseFacts.set(ptyId, { handle, order })
    } else {
      this.reverseFacts.set(ptyId, undefined)
    }
  }

  changedHandle(handle: string): void {
    if (!this.inputs.handlesCaptured) {
      return
    }
    const prior = this.handleFacts.has(handle)
      ? this.handleFacts.get(handle)
      : this.inputs.handleFact(handle)
    const record = this.source.handles.get(handle)
    if (prior?.ptyId === record?.ptyId && record?.tabId.startsWith('pty:')) {
      return
    }
    if (prior) {
      this.edit(this.handleEdits, prior.ptyId, this.inputs.syntheticKeys(prior.ptyId)).delete(
        handle
      )
    }
    if (record?.ptyId && record.tabId.startsWith('pty:')) {
      this.nextHandleOrder ??= this.inputs.handlesSize
      const order = prior?.order ?? this.nextHandleOrder++
      this.edit(this.handleEdits, record.ptyId, this.inputs.syntheticKeys(record.ptyId)).set(
        handle,
        order
      )
      this.handleFacts.set(handle, { ptyId: record.ptyId, order })
    } else {
      this.handleFacts.set(handle, undefined)
    }
  }

  private edit(
    index: IndexedKeys,
    key: string,
    base: OrderedKeys | undefined
  ): Map<string, number> {
    let values = index.get(key)
    if (!values) {
      values = new Map(base)
      index.set(key, values)
    }
    return values
  }
}

export function ptyRecordForPaneKey(
  paneKey: string,
  source: {
    leaves: ReadonlyMap<string, RuntimeLeafRecord>
    ptys: ReadonlyMap<string, RuntimePtyWorktreeRecord>
    leafKey: (tab: string, leaf: string) => string
    capturePaneOf: () => PtyPaneOf
  },
  context?: TerminalIdentityReadContext
): RuntimePtyWorktreeRecord | null {
  const parsed = parsePaneKey(paneKey)
  let leafPty: RuntimePtyWorktreeRecord | null = null
  if (parsed) {
    const leaf = source.leaves.get(source.leafKey(parsed.tabId, parsed.leafId))
    const pty = leaf?.ptyId ? source.ptys.get(leaf.ptyId) : undefined
    if (pty?.connected) {
      return pty
    }
    leafPty = pty ?? null
    const candidates = context ? context.leavesForId(parsed.leafId) : source.leaves.keys()
    for (const key of candidates) {
      const candidate = source.leaves.get(key)
      if (!candidate) {
        continue
      }
      if (candidate.leafId !== parsed.leafId || !candidate.ptyId) {
        continue
      }
      const remintedPty = source.ptys.get(candidate.ptyId)
      if (remintedPty?.connected) {
        return remintedPty
      }
      leafPty ??= remintedPty ?? null
    }
  }
  let newestMatch: RuntimePtyWorktreeRecord | null = null
  let paneOf: PtyPaneOf | undefined
  const candidates = context ? context.ptysForPane(paneKey) : source.ptys.keys()
  for (const ptyId of candidates) {
    const pty = source.ptys.get(ptyId)
    if (!pty) {
      continue
    }
    const recordedPaneKey = (paneOf ??= context?.paneOf ?? source.capturePaneOf())(pty).paneKey
    const ptyPane = parsePaneKey(recordedPaneKey ?? '')
    if (recordedPaneKey === paneKey || (parsed && ptyPane && parsed.leafId === ptyPane.leafId)) {
      if (pty.connected) {
        return pty
      }
      newestMatch = pty
    }
  }
  return leafPty ?? newestMatch
}
