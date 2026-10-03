// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithResolveTerminalPane } from './orca-runtime-resolve-terminal-pane'
import { PROVEN_ABSENT_LEAF_PTY_TTL_MS } from './orca-runtime-core'
import { pruneExpiredProvenAbsentLeafPtyVerdicts } from './proven-absent-leaf-pty-verdicts'
import type { RuntimeTerminalSend } from '../../shared/runtime-types'
import type { TerminalInputKind } from '../../shared/terminal-input-kind'
import type { RuntimeAgentPromptWriteOptions } from './runtime-terminal-contracts'
import {
  assertTerminalInputWithinLimitWithYield,
  buildTerminalSendPayload
} from './terminal-send-payload'
import {
  agentPromptTakesLeadLine,
  buildAgentPromptPasteBytes
} from '../../shared/agent-prompt-injection'

type PromptReplyWindow = {
  writes: Set<Promise<RuntimeTerminalSend>>
  tail: Promise<void>
}

export class OrcaRuntimeWithControllerKnowsPtyIsLive extends OrcaRuntimeWithResolveTerminalPane {
  private lastProvenAbsentLeafPtyVerdictPruneAt: number | undefined
  private terminalInputTails = new Map<string, Promise<void>>()
  private promptReplyWindows = new Map<string, PromptReplyWindow>()
  private promptReplyWaiters = new Map<
    string,
    Set<(window?: PromptReplyWindow) => Promise<RuntimeTerminalSend>>
  >()

  protected async serializeTerminalInput<T>(
    ptyId: string,
    generation: number,
    write: (release: () => void) => Promise<T>
  ): Promise<T> {
    const key = `${ptyId}\u0000${generation}`
    const previous = this.terminalInputTails.get(key) ?? Promise.resolve()
    let release = (): void => {}
    const written = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => written)
    this.terminalInputTails.set(key, tail)
    void tail.then(() => {
      if (this.terminalInputTails.get(key) === tail) {
        this.terminalInputTails.delete(key)
      }
    })
    try {
      await previous
      return await write(release)
    } finally {
      release()
    }
  }

  private serializeTerminalQueryReply(
    ptyId: string,
    generation: number,
    write: () => Promise<RuntimeTerminalSend>
  ): Promise<RuntimeTerminalSend> {
    const key = `${ptyId}\u0000${generation}`
    const waiters = this.promptReplyWaiters.get(key) ?? new Set()
    this.promptReplyWaiters.set(key, waiters)
    let resolve = (_value: RuntimeTerminalSend): void => {}
    let reject = (_error: unknown): void => {}
    const result = new Promise<RuntimeTerminalSend>((accept, fail) => {
      resolve = accept
      reject = fail
    })
    let started: Promise<RuntimeTerminalSend> | undefined
    const start = (window?: PromptReplyWindow): Promise<RuntimeTerminalSend> => {
      if (started) {
        return started
      }
      waiters.delete(start)
      if (waiters.size === 0) {
        this.promptReplyWaiters.delete(key)
      }
      started = (window?.tail ?? Promise.resolve()).then(write)
      if (window) {
        const reply = started
        window.writes.add(reply)
        window.tail = reply.then(
          () => undefined,
          () => undefined
        )
        void reply.then(
          () => window.writes.delete(reply),
          () => window.writes.delete(reply)
        )
      }
      void started.then(resolve, reject)
      return started
    }
    waiters.add(start)
    // Keep a queue position; an active prompt may admit the reply before that position is reached.
    void this.serializeTerminalInput(ptyId, generation, () => start()).catch(reject)
    const window = this.promptReplyWindows.get(key)
    if (window) {
      start(window)
    }
    return result
  }

  private pruneExpiredLeafPtyVerdicts(now: number): void {
    const lastPruneAt = this.lastProvenAbsentLeafPtyVerdictPruneAt
    // Per-key expiry stays exact; throttle whole-cache scans on the keystroke path.
    if (
      lastPruneAt !== undefined &&
      now >= lastPruneAt &&
      now - lastPruneAt < PROVEN_ABSENT_LEAF_PTY_TTL_MS
    ) {
      return
    }
    this.lastProvenAbsentLeafPtyVerdictPruneAt = now
    pruneExpiredProvenAbsentLeafPtyVerdicts(
      this.provenAbsentLeafPtyVerdicts,
      now,
      PROVEN_ABSENT_LEAF_PTY_TTL_MS
    )
  }

  protected controllerKnowsPtyIsLive(ptyId: string): boolean {
    try {
      return this.ptyController?.hasPty?.(ptyId) === true
    } catch {
      // Why: liveness lookup failures are doubt; doubt never gates a write.
      return false
    }
  }

  /** True only on controller-proven absence; live, unknown, and probe errors all answer false. */
  protected isLeafPtyProvenAbsent(ptyId: string): Promise<boolean> {
    this.pruneExpiredLeafPtyVerdicts(Date.now())
    // Why hasPty and not ptysById: graph sync mirrors a connected record for
    // every leaf ptyId — including a prior process's — so runtime records can't
    // distinguish live from stale. The controller's exact-id hasPty is the
    // provider's own synchronous inventory: a known id is alive, skip probing
    // and supersede any cached verdict (the id came back).
    if (this.controllerKnowsPtyIsLive(ptyId)) {
      this.provenAbsentLeafPtyVerdicts.delete(ptyId)
      return Promise.resolve(false)
    }
    const verdictAt = this.provenAbsentLeafPtyVerdicts.get(ptyId)
    if (verdictAt !== undefined) {
      if (Date.now() - verdictAt < PROVEN_ABSENT_LEAF_PTY_TTL_MS) {
        return Promise.resolve(true)
      }
      this.provenAbsentLeafPtyVerdicts.delete(ptyId)
    }
    const probeLiveness = this.ptyController?.probePtyLiveness?.bind(this.ptyController)
    if (!probeLiveness) {
      return Promise.resolve(false)
    }
    const inFlight = this.leafPtyAbsenceProbes.get(ptyId)
    if (inFlight) {
      return inFlight
    }
    const probe = (async () => {
      try {
        if ((await probeLiveness(ptyId)) !== false) {
          return false
        }
        const now = Date.now()
        this.pruneExpiredLeafPtyVerdicts(now)
        this.provenAbsentLeafPtyVerdicts.set(ptyId, now)
        return true
      } catch {
        // Why: a failed probe is unknown, and unknown never rejects a write.
        return false
      } finally {
        this.leafPtyAbsenceProbes.delete(ptyId)
      }
    })()
    this.leafPtyAbsenceProbes.set(ptyId, probe)
    return probe
  }

  async sendTerminal(
    handle: string,
    action: {
      text?: string
      enter?: boolean
      interrupt?: boolean
    },
    options: {
      signal?: AbortSignal
      beforeWrite?: (ptyId: string) => void | Promise<void>
      reserveWrite?: (ptyId: string) => void
      afterWrite?: (ptyId: string) => void | Promise<void>
      suffixFailureError?: string
      inputKind: TerminalInputKind
    }
  ): Promise<RuntimeTerminalSend> {
    const pty = this.getLivePtyForHandle(handle)
    const leaf = pty ? null : this.getLiveLeafForHandle(handle).leaf
    const ptyId = pty?.pty.ptyId ?? leaf?.ptyId
    if (!ptyId || (pty ? !pty.pty.connected : !leaf?.writable)) {
      throw new Error('terminal_not_writable')
    }
    const payload = buildTerminalSendPayload(action)
    if (payload === null) {
      throw new Error('invalid_terminal_send')
    }
    const generation = this.getPtyLifecycleGeneration(ptyId)
    // Reserve the PTY turn before validation or liveness checks can yield.
    const write = async (): Promise<RuntimeTerminalSend> => {
      await assertTerminalInputWithinLimitWithYield(action.text)
      this.assertLiveTerminalHandleTargetsPty(handle, ptyId)
      this.assertAgentPromptGeneration(ptyId, generation)
      if (leaf && (await this.isLeafPtyProvenAbsent(ptyId))) {
        throw new Error('terminal_not_writable')
      }
      await this.writeTerminalAction(ptyId, action, payload, {
        ...options,
        beforeWrite: async (targetPtyId) => {
          this.assertAgentPromptGeneration(ptyId, generation)
          await options.beforeWrite?.(targetPtyId)
          this.assertAgentPromptGeneration(ptyId, generation)
        }
      })
      return { handle, accepted: true, bytesWritten: Buffer.byteLength(payload, 'utf8') }
    }
    return options.inputKind === 'query-reply'
      ? this.serializeTerminalQueryReply(ptyId, generation, write)
      : this.serializeTerminalInput(ptyId, generation, write)
  }

  async sendTerminalAgentPrompt(
    handle: string,
    prompt: string,
    options: RuntimeAgentPromptWriteOptions
  ): Promise<RuntimeTerminalSend> {
    const pty = this.getLivePtyForHandle(handle)
    const leaf = pty ? null : this.getLiveLeafForHandle(handle).leaf
    const ptyId = pty?.pty.ptyId ?? leaf?.ptyId
    if (!ptyId || (pty ? !pty.pty.connected : !leaf?.writable)) {
      throw new Error('terminal_not_writable')
    }
    const generation = this.getPtyLifecycleGeneration(ptyId)
    const agent = this.ptysById.get(ptyId)?.foregroundAgent ?? this.ptysById.get(ptyId)?.launchAgent
    const payload = buildAgentPromptPasteBytes(
      prompt,
      agentPromptTakesLeadLine(agent) ? options.leadLine : undefined
    )
    // Reserve input order before waiting for an earlier prompt's receipt observation.
    const delivery = await this.serializeTerminalInput(ptyId, generation, async (release) => {
      // A prompt owns this turn even while waiting for the prior receipt; replies must still reach it.
      const key = `${ptyId}\u0000${generation}`
      const window: PromptReplyWindow = { writes: new Set(), tail: Promise.resolve() }
      this.promptReplyWindows.set(key, window)
      for (const start of this.promptReplyWaiters.get(key) ?? []) {
        start(window)
      }
      let drained: Promise<void> | undefined
      const closeReplies = (): Promise<void> => {
        if (!drained) {
          if (this.promptReplyWindows.get(key) === window) {
            this.promptReplyWindows.delete(key)
          }
          drained = Promise.allSettled(window.writes).then(() => undefined)
        }
        return drained
      }
      try {
        return await this.serializeAgentPromptSubmission(ptyId, generation, async () => {
          await assertTerminalInputWithinLimitWithYield(payload)
          if (leaf && (await this.isLeafPtyProvenAbsent(ptyId))) {
            throw new Error('terminal_not_writable')
          }
          this.assertLiveTerminalHandleTargetsPty(handle, ptyId)
          this.assertAgentPromptGeneration(ptyId, generation)
          return await this.writeTerminalAgentPrompt(
            handle,
            ptyId,
            generation,
            payload,
            { ...options, promptForSchedule: prompt },
            async () => {
              await closeReplies()
              release()
            }
          )
        })
      } finally {
        await closeReplies()
      }
    })
    return {
      handle,
      accepted: true,
      bytesWritten: Buffer.byteLength(payload, 'utf8') + delivery.submits,
      ...(delivery.prompt ? { prompt: delivery.prompt } : {})
    }
  }
}
