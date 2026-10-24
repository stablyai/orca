import type { RuntimeTerminalWriteOptions } from '../../runtime-terminal-writer'
import type { WriteSettlement } from '../../../../shared/pty-write-settlement'
import type { RuntimeLeafRecord } from '../../runtime-terminal-state-records'
import type {
  RuntimeTerminalPromptDelivery,
  RuntimeTerminalPromptSubmission
} from '../../../../shared/runtime-terminal-send-contract'
import { OrcaRuntimeWithTerminalPtyLiveness } from './terminal-pty-liveness'
import { wrapTerminalBracketedPasteText } from '../../../../shared/terminal-bracketed-paste-text'
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
import { TerminalPromptSubmissions } from '../../terminal-prompt-submissions'
import { recognizeAgentProcess } from '../../../../shared/agent-process-recognition'
import type { TerminalAgent } from '../../../../shared/terminal-agent'

export abstract class OrcaRuntimeWithControllerKnowsPtyIsLive extends OrcaRuntimeWithTerminalPtyLiveness {
  private readonly terminalPromptSubmissions = new TerminalPromptSubmissions()

  protected async resolveTerminalPromptAgent(ptyId: string): Promise<TerminalAgent | null> {
    const foreground = await this.ptyForegroundAgent.read(ptyId)
    const recognized =
      foreground?.controller === this.ptyController && foreground.available
        ? recognizeAgentProcess(foreground.process)?.agent
        : undefined
    const pty = this.ptysById.get(ptyId)
    return recognized ?? pty?.foregroundAgent ?? pty?.launchAgent ?? null
  }

  async queueTerminalAgentPrompt(
    handle: string,
    requestId: string,
    prompt: string,
    options: RuntimeAgentPromptWriteOptions & { onSettled?: () => void }
  ): Promise<RuntimeTerminalPromptSubmission> {
    await assertTerminalInputWithinLimitWithYield(prompt)
    const ptyId =
      this.getLivePtyForHandle(handle)?.pty.ptyId ?? this.getLiveLeafForHandle(handle).leaf.ptyId
    if (!ptyId) {
      throw new Error('terminal_not_writable')
    }
    const generation = this.getPtyLifecycleGeneration(ptyId)
    return this.terminalPromptSubmissions.enqueue(handle, requestId, prompt, (inputWritten) =>
      this.sendTerminalAgentPrompt(handle, prompt, {
        ...options,
        acceptQueued: true,
        observationTimeoutMs: 0,
        waitForRender: false,
        requestId,
        beforeWrite: async (id) => {
          this.assertAgentPromptGeneration(ptyId, generation)
          this.assertLiveTerminalHandleTargetsPty(handle, ptyId)
          await options.beforeWrite?.(id)
        },
        afterWrite: async (id) => {
          inputWritten()
          await options.afterWrite?.(id)
        }
      }).finally(() => {
        // Submission receipts track Enter delivery; no later turn observer owns this registration.
        this.forgetAgentPromptRequest(ptyId, generation, requestId)
        options.onSettled?.()
      })
    )
  }

  waitForTerminalAgentPrompt(
    handle: string,
    requestId: string,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<RuntimeTerminalPromptSubmission> {
    return this.terminalPromptSubmissions.wait(handle, requestId, timeoutMs, signal)
  }

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
  protected abstract forgetAgentPromptRequest(
    ptyId: string,
    generation: number,
    requestId: string
  ): void
  protected abstract writeTerminalAgentPrompt(
    handle: string,
    ptyId: string,
    generation: number,
    pastePayload: string,
    options: RuntimeAgentPromptWriteOptions
  ): Promise<{ submits: number; prompt?: RuntimeTerminalPromptDelivery }>
  /** The opt-in path (`onPermission: 'wait'`, `expectedBinding`), pinned to `ptyId`. */
  protected abstract submitTerminalAgentPrompt(
    handle: string,
    ptyId: string,
    prompt: string,
    payload: string,
    options: RuntimeAgentPromptWriteOptions
  ): Promise<RuntimeTerminalSend>

  async sendTerminal(
    handle: string,
    action: {
      text?: string
      enter?: boolean
      interrupt?: boolean
    },
    options: RuntimeTerminalWriteOptions & {
      includeSubmitDelay?: true
    }
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
    let ptyId: string
    if (pty) {
      if (!pty.pty.connected) {
        throw new Error('terminal_not_writable')
      }
      ptyId = pty.pty.ptyId
    } else {
      const { leaf } = this.getLiveLeafForHandle(handle)
      if (!leaf.writable || !leaf.ptyId) {
        throw new Error('terminal_not_writable')
      }
      ptyId = leaf.ptyId
    }

    const payload = buildTerminalSendPayload(action)
    if (payload === null) {
      throw new Error('invalid_terminal_send')
    }
    await assertTerminalInputWithinLimitWithYield(action.text)
    // Why: leaf.writable mirrors the renderer graph, which can still answer for
    // a prior process's ptyId — and provider writes to unknown ids are accepted
    // no-ops. Only controller-proven absence rejects; unknown proceeds (a
    // restored daemon session takes writes before its pane remounts).
    if (!pty && (await this.isLeafPtyProvenAbsent(ptyId))) {
      throw new Error('terminal_not_writable')
    }

    const writeSettlement = await this.writeTerminalAction(ptyId, action, payload, options)
    const accepted = !writeSettlement || writeSettlement.outcome === 'accepted'
    const submitText =
      options.includeSubmitDelay && !action.enter && !action.interrupt ? action.text : undefined
    return {
      handle,
      accepted,
      ...(writeSettlement ? { writeSettlement } : {}),
      bytesWritten: accepted ? Buffer.byteLength(payload, 'utf8') : 0,
      ...(accepted && submitText
        ? {
            submitDelayMs: this.terminalWriter.getSubmitDelayMs(
              ptyId,
              submitText,
              await this.resolveTerminalPromptAgent(ptyId)
            )
          }
        : {})
    }
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
      ? this.startRestoredHandlePane(handle, { signal: options.signal })
      : null
    if (starting) {
      const target = await starting
      return { ...(await this.sendTerminalAgentPrompt(target, prompt, options)), handle }
    }
    const pty = this.getLivePtyForHandle(handle)
    if (pty) {
      if (!pty.pty.connected) {
        throw new Error('terminal_not_writable')
      }
      const payload = payloadFor(pty.pty.ptyId)
      await assertTerminalInputWithinLimitWithYield(payload)
      // Only opted-in calls take the extra layer, so every default caller's timing is untouched.
      if (agentPromptWriteOptsIn(options)) {
        return await this.submitTerminalAgentPrompt(handle, pty.pty.ptyId, prompt, payload, options)
      }
      const generation = this.getPtyLifecycleGeneration(pty.pty.ptyId)
      const delivery = await this.serializeAgentPromptSubmission(
        pty.pty.ptyId,
        generation,
        async () => {
          this.assertLiveTerminalHandleTargetsPty(handle, pty.pty.ptyId)
          this.assertAgentPromptGeneration(pty.pty.ptyId, generation)
          return await this.writeTerminalAgentPrompt(handle, pty.pty.ptyId, generation, payload, {
            ...options,
            promptForSchedule: prompt
          })
        }
      )
      const bytesWritten = Buffer.byteLength(payload, 'utf8') + delivery.submits
      return {
        handle,
        accepted: true,
        bytesWritten,
        ...(delivery.prompt ? { prompt: delivery.prompt } : {})
      }
    }

    const { leaf } = this.getLiveLeafForHandle(handle)
    if (!leaf.writable || !leaf.ptyId) {
      throw new Error('terminal_not_writable')
    }
    const payload = payloadFor(leaf.ptyId)
    await assertTerminalInputWithinLimitWithYield(payload)
    // Why: same absence gate as sendTerminal — a stale graph mirror must not
    // accept a prompt into a void; unknown liveness still proceeds.
    if (await this.isLeafPtyProvenAbsent(leaf.ptyId)) {
      throw new Error('terminal_not_writable')
    }
    if (agentPromptWriteOptsIn(options)) {
      return await this.submitTerminalAgentPrompt(handle, leaf.ptyId, prompt, payload, options)
    }
    const generation = this.getPtyLifecycleGeneration(leaf.ptyId)
    const delivery = await this.serializeAgentPromptSubmission(leaf.ptyId, generation, async () => {
      this.assertLiveTerminalHandleTargetsPty(handle, leaf.ptyId!)
      this.assertAgentPromptGeneration(leaf.ptyId!, generation)
      return await this.writeTerminalAgentPrompt(handle, leaf.ptyId!, generation, payload, {
        ...options,
        promptForSchedule: prompt
      })
    })
    const bytesWritten = Buffer.byteLength(payload, 'utf8') + delivery.submits
    return {
      handle,
      accepted: true,
      bytesWritten,
      ...(delivery.prompt ? { prompt: delivery.prompt } : {})
    }
  }
}

function agentPromptWriteOptsIn(options: RuntimeAgentPromptWriteOptions): boolean {
  return options.onPermission === 'wait' || options.expectedBinding !== undefined
}
