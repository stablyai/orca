import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { TerminalAgent } from '../../../../shared/agent-status/identity/terminal-agent'
import {
  isAgentForegroundWrapperProcess,
  recognizeAgentProcess
} from '../../../../shared/agent-status/process/agent-process-recognition'
import { isShellProcess } from '../../../../shared/agent-status/process/shell-process-detection'
import { resolveTerminalTitlePolicyAgentType } from '../../../../shared/agent-status/title/terminal-title-agent-type'
import { agentPaintSignal } from '../input/terminal-command-paint'
import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import type { PtyForegroundProcessRead } from './pty-foreground-observation-state'

export type StartupAgentObservation =
  | { kind: 'shell'; candidate: TuiAgent }
  | { kind: 'agent'; agent: TerminalAgent; inputMode?: 'noninteractive' }
  | { kind: 'non-agent' }

type Dependencies = {
  getController(): RuntimePtyController | null
  getPty(ptyId: string): RuntimePtyWorktreeRecord | null
  getOutputSequence?(ptyId: string): number | undefined
  read(
    ptyId: string,
    generation: PtyStartupObservationEntry,
    isCurrent: () => boolean
  ): Promise<PtyForegroundProcessRead> | null
}

export type PtyStartupObservationEntry = {
  pty: RuntimePtyWorktreeRecord
  controller: RuntimePtyController | null
  incarnation: RuntimePtyWorktreeRecord['incarnationId']
  providerGeneration: number | undefined
  paint: RuntimePtyWorktreeRecord['commandPaint']
  commandEpoch: number
  listeners: Set<() => void>
  result: StartupAgentObservation | null
  outputAt: number | null
  outputSequence: number | undefined
  flight: Promise<void> | null
  nextAttemptAt: number
  retryMs: number
  unsupported: boolean
  modeExpiresAt: number
}

function knownClaude(pty: RuntimePtyWorktreeRecord): boolean {
  return (
    [pty.launchAgent, pty.launchCommandAgent, pty.foregroundAgent].includes('claude') ||
    (pty.commandPaint?.commandActive !== false &&
      resolveTerminalTitlePolicyAgentType(pty.lastOscTitle ?? '') === 'claude')
  )
}

// The terminal owns discovery; additional waiters neither multiply reads nor restart recovery.
export class PtyStartupObservation {
  private readonly entries = new Map<string, PtyStartupObservationEntry>()

  constructor(private readonly deps: Dependencies) {}

  private entry(ptyId: string): PtyStartupObservationEntry | null {
    const pty = this.deps.getPty(ptyId)
    if (!pty) {
      return null
    }
    const controller = this.deps.getController()
    let entry = this.entries.get(ptyId)
    let cleared = false
    if (
      !entry ||
      entry.pty !== pty ||
      entry.controller !== controller ||
      entry.incarnation !== pty.incarnationId ||
      entry.providerGeneration !== pty.providerGenerationResetAtEpochMs ||
      entry.paint !== pty.commandPaint ||
      entry.commandEpoch !== (pty.commandPaint?.commandEpoch ?? 0)
    ) {
      cleared = entry?.result != null
      entry = {
        pty,
        controller,
        incarnation: pty.incarnationId,
        providerGeneration: pty.providerGenerationResetAtEpochMs,
        paint: pty.commandPaint,
        commandEpoch: pty.commandPaint?.commandEpoch ?? 0,
        listeners: entry?.listeners ?? new Set(),
        result: null,
        outputAt: pty.lastOutputAt,
        outputSequence: this.deps.getOutputSequence?.(ptyId),
        flight: null,
        nextAttemptAt: 0,
        retryMs: 2_000,
        unsupported: false,
        modeExpiresAt: 0
      }
      this.entries.set(ptyId, entry)
    }
    if (
      entry.outputAt !== pty.lastOutputAt ||
      entry.outputSequence !== this.deps.getOutputSequence?.(ptyId) ||
      (entry.result?.kind === 'agent' &&
        entry.result.inputMode &&
        performance.now() >= entry.modeExpiresAt)
    ) {
      cleared ||= entry.result != null
      entry.result = null
      entry.outputAt = pty.lastOutputAt
      entry.outputSequence = this.deps.getOutputSequence?.(ptyId)
    }
    if (cleared) {
      const clearedEntry = entry
      queueMicrotask(() => {
        if (this.entries.get(ptyId) === clearedEntry) {
          for (const changed of Array.from(clearedEntry.listeners)) {
            changed()
          }
        }
      })
    }
    return entry
  }

  read(ptyId: string): StartupAgentObservation | undefined {
    const pty = this.deps.getPty(ptyId)
    if (!pty) {
      return undefined
    }
    const entry = this.entry(ptyId)
    if (entry?.result?.kind === 'agent' && entry.result.inputMode) {
      return entry.result
    }
    if (knownClaude(pty)) {
      this.refresh(ptyId)
    }
    if (pty.launchAgent || pty.launchCommandAgent) {
      return undefined
    }
    const candidate = resolveTerminalTitlePolicyAgentType(pty.lastOscTitle ?? '')
    if (!isTuiAgent(candidate)) {
      return undefined
    }
    const signal = agentPaintSignal(candidate)
    if (pty.commandPaint?.commandActive !== true) {
      return pty.commandPaint?.commandActive === false ? { kind: 'non-agent' } : undefined
    }
    if (pty.foregroundAgent) {
      return undefined
    }
    if (signal && pty.commandPaint.hasObservedAgentComposer(signal)) {
      return { kind: 'agent', agent: candidate }
    }
    this.refresh(ptyId)
    return entry?.listeners.size ? (entry.result ?? undefined) : undefined
  }

  noninteractiveRemainingMs(ptyId: string): number | undefined {
    const entry = this.entry(ptyId)
    return entry?.result?.kind === 'agent' && entry.result.inputMode === 'noninteractive'
      ? Math.max(0, entry.modeExpiresAt - performance.now())
      : undefined
  }

  watch(ptyId: string, changed: () => void): () => void {
    const entry = this.entry(ptyId)
    if (!entry) {
      return () => {}
    }
    if (!entry.listeners.size && !(entry.result?.kind === 'agent' && entry.result.inputMode)) {
      entry.result = null
    }
    entry.listeners.add(changed)
    this.refresh(ptyId)
    return () => this.entries.get(ptyId)?.listeners.delete(changed)
  }

  refresh(ptyId: string): void {
    const entry = this.entry(ptyId)
    if (
      !entry ||
      entry.pty.commandPaint?.commandBoundaryPending ||
      !entry.listeners.size ||
      entry.flight ||
      entry.unsupported ||
      Date.now() < entry.nextAttemptAt ||
      (!knownClaude(entry.pty) &&
        (entry.pty.commandPaint?.commandActive !== true ||
          entry.pty.launchAgent ||
          entry.pty.launchCommandAgent ||
          entry.pty.foregroundAgent ||
          !isTuiAgent(resolveTerminalTitlePolicyAgentType(entry.pty.lastOscTitle ?? ''))))
    ) {
      return
    }
    const read = this.deps.read(ptyId, entry, () => this.current(ptyId, entry))
    if (!read) {
      return
    }
    const outputAt = entry.pty.lastOutputAt
    const outputSequence = this.deps.getOutputSequence?.(ptyId)
    const previous = entry.result
    entry.flight = read
      .then((sample) => {
        if (
          !this.current(ptyId, entry) ||
          entry.pty.lastOutputAt !== outputAt ||
          this.deps.getOutputSequence?.(ptyId) !== outputSequence
        ) {
          return
        }
        entry.unsupported = sample.unsupported === true
        entry.result = null
        if (!sample.available || !sample.process) {
          return
        }
        const agent = sample.agent ?? recognizeAgentProcess(sample.process)?.agent
        if (agent) {
          const observation = sample.observation
          const inputMode = observation?.verdict === 'observed' ? observation.inputMode : undefined
          entry.modeExpiresAt =
            performance.now() + Math.max(0, 16_000 - (observation?.capturedAgeMs ?? 0))
          entry.result = {
            kind: 'agent',
            agent,
            ...(inputMode && performance.now() < entry.modeExpiresAt ? { inputMode } : {})
          }
        } else if (isShellProcess(sample.process)) {
          const candidate = resolveTerminalTitlePolicyAgentType(entry.pty.lastOscTitle ?? '')
          if (isTuiAgent(candidate)) {
            entry.result = { kind: 'shell', candidate }
          }
        } else if (
          sample.observation?.verdict === 'observed' &&
          sample.observation.foregroundKind === 'non-shell' &&
          !isShellProcess(sample.process) &&
          !isAgentForegroundWrapperProcess(sample.process) &&
          !/^\d+\.\d+\.\d+$/.test(sample.process)
        ) {
          entry.result = { kind: 'non-agent' }
        }
      })
      .catch(() => {
        if (this.current(ptyId, entry)) {
          entry.result = null
        }
      })
      .finally(() => {
        if (this.entry(ptyId) !== entry) {
          return
        }
        entry.flight = null
        entry.nextAttemptAt = Date.now() + entry.retryMs
        entry.retryMs = Math.min(entry.retryMs * 2, 16_000)
        if (entry.result || previous) {
          for (const changed of Array.from(entry.listeners)) {
            changed()
          }
        }
      })
  }

  private current(ptyId: string, entry: PtyStartupObservationEntry): boolean {
    return this.entry(ptyId) === entry && entry.listeners.size > 0
  }

  forget(ptyId: string, preserveInterest = false): void {
    const entry = this.entries.get(ptyId)
    if (preserveInterest && entry?.listeners.size) {
      entry.commandEpoch = -1
      entry.result = null
    } else {
      this.entries.delete(ptyId)
    }
  }
}
