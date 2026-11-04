import type { TerminalUsageLimitSourceResult } from '../../../../shared/terminal-usage-limit-source-validation'
import { randomUUID } from 'node:crypto'
import { OrcaRuntimeWithAgentPromptRequestCorrelation } from '../../orca-runtime-agent-prompt-request-correlation'
import { readTerminalComposerTypedText } from '../../../../shared/terminal/input/terminal-composer-draft'
import { NATIVE_CHAT_USAGE_LIMIT_CONTINUE_MESSAGE } from '../../../../shared/native-chat/native-chat-usage-limit-cut'
import { hasTerminalDialogScreen } from '../../claude-open-dialog-hold'
import { detectTerminalWaitBlockedReason } from '../../terminal-wait-detection'
import type { TerminalInputSource } from '../../terminal-input-admission'
import { assertTerminalInputAdmitted } from '../../terminal-input-admission'
import type { TerminalUsageLimitContinuationResult } from '../../../../shared/terminal-usage-limit-continuation'

type Refusal = Extract<TerminalUsageLimitContinuationResult, { status: 'refused' }>['reason']

class ContinuationRefused extends Error {
  constructor(readonly reason: Refusal) {
    super('terminal_usage_limit_continuation_refused')
  }
}

export abstract class OrcaRuntimeWithTerminalUsageLimitContinuation extends OrcaRuntimeWithAgentPromptRequestCorrelation {
  private readonly usageLimitContinuations = new Set<string>()

  async continueTerminalUsageLimit(
    handle: string,
    isCurrent: () => boolean,
    inputSource: TerminalInputSource,
    signal?: AbortSignal,
    validateSource?: () => Promise<TerminalUsageLimitSourceResult>
  ): Promise<TerminalUsageLimitContinuationResult> {
    const binding = this.getTerminalPromptRequestBinding(handle)
    const { ptyId } = binding
    const paneKey = this.getLiveTerminalPaneKey(handle)
    if (this.usageLimitContinuations.has(ptyId)) {
      return { status: 'refused', reason: 'in-progress' }
    }
    this.usageLimitContinuations.add(ptyId)
    let preparedPrompt: string | undefined
    let expectedInput = this.terminalRunFacts.readInputSequence(ptyId)
    let outputSequence = -1
    let handedOff = 0
    let accepted = 0
    let submitted = false
    const assertCurrent = (): void => {
      assertTerminalInputAdmitted(this, ptyId, inputSource)
      const current = this.getTerminalPromptRequestBinding(handle)
      if (
        signal?.aborted ||
        this.getLiveTerminalPaneKey(handle) !== paneKey ||
        this.isPtyStopRequested(ptyId) ||
        current.ptyId !== ptyId ||
        current.processIncarnation !== binding.processIncarnation ||
        current.generation !== binding.generation ||
        this.terminalRunFacts.readInputSequence(ptyId) !== expectedInput ||
        !isCurrent()
      ) {
        throw new ContinuationRefused('changed')
      }
    }
    const assertComposer = (): void => {
      assertCurrent()
      const model = this.readWholeScreenModel(ptyId)
      if (!model || model.outputSequence !== this.getPtyOutputSequence(ptyId)) {
        throw new ContinuationRefused('unavailable')
      }
      const lines = model.emulator.getVisibleLines()
      const activity = this.getAgentPromptActivity(handle, ptyId)
      if (
        activity.status === 'permission' ||
        hasTerminalDialogScreen(lines) ||
        detectTerminalWaitBlockedReason(lines.join('\n'))
      ) {
        throw new ContinuationRefused('permission')
      }
      if (
        activity.status === 'working' ||
        /\b(?:esc(?:ape)?|ctrl[+-]c)\s+(?:to\s+)?(?:cancel|interrupt|stop)\b/i.test(
          lines.slice(-14).join('\n')
        )
      ) {
        throw new ContinuationRefused('changed')
      }
      const text = readTerminalComposerTypedText(model.emulator.getCursorLineContext())
      if (text === null || text !== (accepted === 0 ? '' : preparedPrompt)) {
        throw new ContinuationRefused(text ? 'draft' : 'unavailable')
      }
      outputSequence = model.outputSequence
    }
    try {
      const result = await this.sendTerminalAgentPrompt(
        handle,
        NATIVE_CHAT_USAGE_LIMIT_CONTINUE_MESSAGE,
        {
          inputKind: 'orchestration',
          inputSource,
          signal,
          expectedBinding: binding,
          requireWriteSettlement: true,
          composerReady: true,
          acceptQueued: true,
          requestId: randomUUID(),
          onPromptPrepared: (prompt) => {
            preparedPrompt = prompt
          },
          beforeWrite: async () => {
            assertCurrent()
            if (validateSource) {
              const source = await validateSource()
              if (source.status !== 'current') {
                throw new ContinuationRefused(
                  source.status === 'changed' ? 'changed' : 'unavailable'
                )
              }
            }
            const model = this.readWholeScreenModel(ptyId)
            if (model) {
              await model.writeChain
            }
            assertComposer()
          },
          reserveWrite: () => {
            if (outputSequence !== this.getPtyOutputSequence(ptyId)) {
              assertComposer()
            }
            assertCurrent()
            handedOff += 1
          },
          afterWrite: () => {
            accepted += 1
            expectedInput += 1
          },
          onSubmitWritten: () => {
            submitted = true
          }
        }
      )
      return {
        status: result.prompt?.stages.includes('turn_started') ? 'turn-started' : 'input-accepted'
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'terminal_input_refused') {
        handedOff -= 1
      }
      if (accepted > 0 && !submitted && accepted === handedOff) {
        return { status: 'draft' }
      }
      if (handedOff > accepted || submitted) {
        return { status: 'unknown' }
      }
      return {
        status: 'refused',
        reason: error instanceof ContinuationRefused ? error.reason : 'unavailable'
      }
    } finally {
      this.usageLimitContinuations.delete(ptyId)
    }
  }
}
