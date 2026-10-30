import { agentPromptObservationSignal } from './agent-prompt-signals'
import type { RuntimeTerminalWriteOptions } from '../../runtime-terminal-writer'
import type { WriteSettlement } from '../../../../shared/pty-write-settlement'
import type { RuntimeLeafRecord } from '../../runtime-terminal-state-records'
import type { RuntimeTerminalPromptDelivery } from '../../../../shared/runtime-terminal-send-contract'
import { OrcaRuntimeWithResolveTerminalPane } from '../recovery/resolve-terminal-pane'
import { wrapTerminalBracketedPasteText } from '../../../../shared/terminal-bracketed-paste-text'
import { PROVEN_ABSENT_LEAF_PTY_TTL_MS } from '../../orca-runtime-core'
import { pruneExpiredProvenAbsentLeafPtyVerdicts } from '../../proven-absent-leaf-pty-verdicts'
import type { RuntimeTerminalSend } from '../../../../shared/runtime-types'
import type {
  RuntimeAgentPromptWriteOptions,
  TerminalHandleRecord
} from '../../runtime-terminal-contracts'
import {
  assertTerminalInputWithinLimitWithYield,
  buildTerminalSendPayload
} from '../../terminal-send-payload'
import {
  agentPromptTakesLeadLine,
  buildAgentPromptPasteBytes
} from '../../../../shared/agent-prompt-injection'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'

type PromptReplyWindow = {
  writes: Set<Promise<RuntimeTerminalSend>>
  tail: Promise<void>
}

export abstract class OrcaRuntimeWithControllerKnowsPtyIsLive extends OrcaRuntimeWithResolveTerminalPane {
  protected abstract writeTerminalAction(
    ptyId: string,
    action: { text?: string; enter?: boolean; interrupt?: boolean },
    payload: string,
    options: RuntimeTerminalWriteOptions
  ): Promise<WriteSettlement | undefined>
  protected abstract getLiveLeafForHandle(handle: string): {
    record: TerminalHandleRecord
    leaf: RuntimeLeafRecord
  }
  protected abstract serializeAgentPromptSubmission<T>(
    ptyId: string,
    generation: number,
    submit: () => Promise<T>
  ): Promise<T>
  protected abstract assertAgentPromptGeneration(ptyId: string, expected: number): void
  protected abstract writeTerminalAgentPrompt(
    handle: string,
    ptyId: string,
    generation: number,
    pastePayload: string,
    options: RuntimeAgentPromptWriteOptions,
    onInputWritten?: () => void | Promise<void>
  ): Promise<{ submits: number; prompt?: RuntimeTerminalPromptDelivery }>
  /** The opt-in path (`onPermission: 'wait'`, `expectedBinding`), pinned to `ptyId`. */
  protected abstract submitTerminalAgentPrompt(
    handle: string,
    ptyId: string,
    prompt: string,
    payload: string,
    options: RuntimeAgentPromptWriteOptions
  ): Promise<RuntimeTerminalSend>

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
    // Controller hasPty supersedes cached absence; graph-mirrored records can describe a prior process under the same id.
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
    options: RuntimeTerminalWriteOptions
  ): Promise<RuntimeTerminalSend> {
    // Switch point: a saved pane main holds with no terminal yet starts first (once, shared).
    const starting = ORCA_LAYOUT_OWNER_IS_MAIN
      ? this.startRestoredHandlePane(handle, { signal: options.signal })
      : null
    if (starting) {
      const target = await starting
      return { ...(await this.sendTerminal(target, action, options)), handle }
    }
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
      const writeSettlement = await this.writeTerminalAction(ptyId, action, payload, {
        ...options,
        beforeWrite: async (targetPtyId) => {
          this.assertAgentPromptGeneration(ptyId, generation)
          await options.beforeWrite?.(targetPtyId)
          this.assertAgentPromptGeneration(ptyId, generation)
        }
      })
      return {
        handle,
        accepted: !writeSettlement || writeSettlement.outcome === 'accepted',
        ...(writeSettlement ? { writeSettlement } : {}),
        bytesWritten:
          !writeSettlement || writeSettlement.outcome === 'accepted'
            ? Buffer.byteLength(payload, 'utf8')
            : 0
      }
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
    // Why the consuming agent: the foreground process reads the bytes; launchAgent covers startup.
    const payloadFor = (ptyId: string): string => {
      // Why: a launch prompt replaced the desktop's draft paste, so it sends that paste's bytes.
      if (options.inputKind === 'launch') {
        return wrapTerminalBracketedPasteText(prompt)
      }
      const pty = this.ptysById.get(ptyId)
      const agent = pty?.foregroundAgent ?? pty?.launchAgent
      return buildAgentPromptPasteBytes(
        prompt,
        agentPromptTakesLeadLine(agent) ? options.leadLine : undefined
      )
    }
    // Switch point: a saved pane main holds with no terminal yet starts first (once, shared).
    const starting = ORCA_LAYOUT_OWNER_IS_MAIN
      ? this.startRestoredHandlePane(handle, { signal: agentPromptObservationSignal(options) })
      : null
    if (starting) {
      const target = await starting
      return { ...(await this.sendTerminalAgentPrompt(target, prompt, options)), handle }
    }
    const pty = this.getLivePtyForHandle(handle)
    const leaf = pty ? null : this.getLiveLeafForHandle(handle).leaf
    const ptyId = pty?.pty.ptyId ?? leaf?.ptyId
    if (!ptyId || (pty ? !pty.pty.connected : !leaf?.writable)) {
      throw new Error('terminal_not_writable')
    }
    const payload = payloadFor(ptyId)
    // Only opted-in calls take the extra layer, so every default caller's timing is untouched.
    if (agentPromptWriteOptsIn(options)) {
      return await this.submitTerminalAgentPrompt(handle, ptyId, prompt, payload, options)
    }
    const generation = this.getPtyLifecycleGeneration(ptyId)
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

function agentPromptWriteOptsIn(options: RuntimeAgentPromptWriteOptions): boolean {
  return options.onPermission === 'wait' || options.expectedBinding !== undefined
}
