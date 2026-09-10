import { queryProviderResourceObservation, sameObject } from './provider-resource-observation-query'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, realpath, type FileHandle } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { isWslUncPath } from '../../shared/wsl-paths'
import { readProcessStartTimeMs } from '../runtime/agent-session-process-identity-probe'
import {
  unavailableProviderResourceDiagnostic,
  type ProviderResourceDiagnosticHook,
  type ProviderResourceDiagnosticQuery,
  type ProviderResourceDiagnosticResult
} from '../../shared/provider-resource-diagnostics'

const MAX_RECORDS = 128
const MAX_PENDING_PROBES = 8
const TRIAL_MS = 15 * 60_000
const HOOK_KINDS = new Set(['SessionStart', 'SessionEnd', 'Stop', 'PreCompact', 'PostCompact'])

type ObjectWitness = { dev: bigint; ino: bigint }
export type LaunchObservation = {
  id: string
  ptyId: string
  incarnationId: string
  pid?: number
  processStartTimeMs?: number | null
  paneKey: string
  launchToken: string
  rootPath?: string
  root?: ObjectWitness
  rootHandle?: FileHandle
  expiry?: ReturnType<typeof setTimeout>
  pendingHook?: { run: () => Promise<void>; cancel: () => void }
  expiresAt: number
  busy: boolean
  observation?: {
    transcript?: { handle: FileHandle; path: string; object: ObjectWitness; observationId: string }
    hook: {
      sessionId: string
      sessionCorrelationId: string
      launchTokenMatches: boolean
      sequence: number
      receivedAt: number
      kind: string
    }
  }
}

/** Lives in the execution owner; pane projection and transport disconnect never clear it. */
export class ProviderResourceObservations {
  readonly epoch = randomUUID()
  private readonly records = new Map<string, LaunchObservation>()
  private pending = 0
  private sequence = 0
  private trialEndsAt: number | undefined

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ptyVerdict: (
      id: string,
      incarnationId: string
    ) => 'live' | 'unverifiable' | 'exited' = () => 'unverifiable'
  ) {}

  captureLaunch(args: {
    ptyId: string
    incarnationId: string
    pid?: number
    env: Record<string, string>
    wsl?: boolean
  }): void {
    if (args.env.ORCA_PROVIDER_RESOURCE_DIAGNOSTICS !== '1' || args.wsl) {
      return
    }
    this.trialEndsAt ??= this.now() + TRIAL_MS
    if (this.now() >= this.trialEndsAt) {
      return
    }
    const paneKey = args.env.ORCA_PANE_KEY
    const launchToken = args.env.ORCA_AGENT_LAUNCH_TOKEN
    if (!paneKey || !launchToken) {
      return
    }
    this.prune()
    if (this.records.size >= MAX_RECORDS) {
      const oldest = this.records.values().next().value as LaunchObservation | undefined
      if (oldest) {
        this.remove(oldest)
      }
    }
    const record: LaunchObservation = {
      id: randomUUID(),
      ptyId: args.ptyId,
      incarnationId: args.incarnationId,
      ...(args.pid ? { pid: args.pid } : {}),
      paneKey,
      launchToken,
      expiresAt: this.trialEndsAt,
      busy: false
    }
    this.records.set(record.id, record)
    record.expiry = setTimeout(
      () => this.remove(record),
      Math.max(0, record.expiresAt - this.now())
    )
    record.expiry.unref()
    // An omitted root is missing evidence; the controller's account default is not a substitute.
    const root = args.env.CLAUDE_CONFIG_DIR
    void this.probe(record, async () => {
      if (record.pid && process.platform !== 'win32') {
        record.processStartTimeMs = await readProcessStartTimeMs(record.pid)
      }
      if (root && isAbsolute(root) && !(process.platform === 'win32' && isWslUncPath(root))) {
        const rootPath = await realpath(root)
        const handle = await open(rootPath, constants.O_RDONLY | constants.O_NONBLOCK)
        try {
          const witness = await handle.stat({ bigint: true })
          if (witness.isDirectory() && this.retains(record)) {
            record.rootPath = rootPath
            record.root = witness
            record.rootHandle = handle
          }
        } finally {
          if (record.rootHandle !== handle) {
            await handle.close()
          }
        }
      }
    })
  }

  async observeHook(event: ProviderResourceDiagnosticHook): Promise<void> {
    this.prune()
    if (!HOOK_KINDS.has(event.hookEventName ?? '')) {
      return
    }
    const session = event.providerSession
    if (!session || session.id.length > 512) {
      return
    }
    const sequence = ++this.sequence
    // Token equality is only correspondence with launch metadata, never sender authentication.
    const matchingLaunches = [...this.records.values()].filter(
      (candidate) =>
        candidate.paneKey === event.paneKey &&
        Boolean(event.launchToken) &&
        candidate.launchToken === event.launchToken
    )
    if (matchingLaunches.length !== 1) {
      return
    }
    const record = matchingLaunches[0]!
    const previous = record.observation
    const observation: NonNullable<LaunchObservation['observation']> = {
      hook: {
        sessionId: session.id,
        sessionCorrelationId:
          previous?.hook.sessionId === session.id
            ? previous.hook.sessionCorrelationId
            : randomUUID(),
        launchTokenMatches: true,
        sequence,
        receivedAt: this.now(),
        kind: event.hookEventName!
      }
    }
    // A new report invalidates the entire correspondence, including during an in-flight probe.
    record.observation = observation
    record.pendingHook?.cancel()
    delete record.pendingHook
    const releasePrevious = () => {
      void previous?.transcript?.handle.close().catch(() => {})
    }
    const path = session.transcriptPath
    if (!path || !isAbsolute(path) || !path.endsWith('.jsonl') || path.length > 4096) {
      releasePrevious()
      return
    }
    if (process.platform === 'win32' && isWslUncPath(path)) {
      releasePrevious()
      return
    }
    const probe = () =>
      this.probe(record, async () => {
        const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
        try {
          const object = await handle.stat({ bigint: true })
          if (!object.isFile() || !this.retains(record) || record.observation !== observation) {
            return
          }
          const retainedAlias = [...this.records.values()].find(
            (candidate) =>
              candidate.observation?.transcript &&
              sameObject(candidate.observation.transcript.object, object)
          )
          observation.transcript = {
            handle,
            path,
            object,
            observationId:
              retainedAlias?.observation?.transcript?.observationId ??
              (previous?.transcript && sameObject(previous.transcript.object, object)
                ? previous.transcript.observationId
                : randomUUID())
          }
        } finally {
          if (observation.transcript?.handle !== handle) {
            await handle.close()
          }
        }
      }).finally(releasePrevious)
    if (record.busy) {
      record.pendingHook = { run: probe, cancel: releasePrevious }
    } else {
      await probe()
    }
  }

  async query(
    query: ProviderResourceDiagnosticQuery,
    ptyVerdict = this.ptyVerdict
  ): Promise<ProviderResourceDiagnosticResult> {
    this.prune()
    if (this.pending >= MAX_PENDING_PROBES) {
      return unavailableProviderResourceDiagnostic(query.requestId, 'probe-capacity')
    }
    this.pending++
    try {
      return await queryProviderResourceObservation(query, {
        epoch: this.epoch,
        records: this.records,
        ptyVerdict,
        retains: (record) => this.retains(record),
        finishProbe: (record) => this.finishProbe(record)
      })
    } finally {
      this.pending--
    }
  }

  private async probe(record: LaunchObservation, run: () => Promise<void>): Promise<void> {
    if (record.busy || this.pending >= MAX_PENDING_PROBES) {
      return
    }
    record.busy = true
    this.pending++
    try {
      await run()
    } catch {
      /* Missing metadata cannot fail a production hook or launch. */
    } finally {
      this.pending--
      this.finishProbe(record)
    }
  }

  private finishProbe(record: LaunchObservation): void {
    record.busy = false
    const pendingHook = record.pendingHook
    delete record.pendingHook
    if (pendingHook && this.retains(record)) {
      void pendingHook.run()
    } else {
      pendingHook?.cancel()
    }
  }

  private retains(record: LaunchObservation): boolean {
    return this.records.get(record.id) === record && this.now() < record.expiresAt
  }

  private prune(): void {
    for (const record of this.records.values()) {
      if (this.now() >= record.expiresAt) {
        this.remove(record)
      }
    }
  }

  private remove(record: LaunchObservation): void {
    this.records.delete(record.id)
    clearTimeout(record.expiry)
    record.pendingHook?.cancel()
    delete record.pendingHook
    void record.observation?.transcript?.handle.close().catch(() => {})
    void record.rootHandle?.close().catch(() => {})
  }

  dispose(): void {
    for (const record of this.records.values()) {
      this.remove(record)
    }
  }
}
