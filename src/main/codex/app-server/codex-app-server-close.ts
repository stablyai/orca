import type { ManagedProviderProcess } from '../../provider-process/managed-provider-process'
import type { ProviderProcessTree } from '../../provider-process/provider-process-close'
import type { ProviderReceiveDisposition } from '../../provider-process/provider-source-completion'
import {
  AgentSessionAcquisitionExitProvenError,
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionAcquisitionRootExitObservedError
} from '../../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { CodexCloseOutcome } from './codex-app-server-connection-types'

/** Both projections consume the same physical attempt and finite input receipt. */
export function createCodexConnectionClose(input: {
  managed: ManagedProviderProcess
  tree: ProviderProcessTree
  begin: () => void
  inputEnding: () => boolean
  finishOutput: () => Promise<void>
  observeRootExit: () => void
  exitPublication: () => Promise<void> | undefined
}): {
  closeOutcome: () => Promise<CodexCloseOutcome>
  close: () => Promise<boolean>
} {
  let attempt: Promise<CodexCloseOutcome> | undefined
  let receiveResult: Promise<ProviderReceiveDisposition> | undefined
  const closeOutcome = (): Promise<CodexCloseOutcome> => {
    if (attempt) {
      return attempt
    }
    input.begin()
    const current = input.managed
      .close(input.tree)
      .then(async (physical): Promise<CodexCloseOutcome> => {
        const accepted = physical.root === 'exited' || physical.killDelivered === true
        const processless = input.managed.processless
        if (physical.root === 'exited') {
          input.observeRootExit()
        }
        let receive: ProviderReceiveDisposition = { state: 'retained' }
        if (accepted || input.inputEnding()) {
          receiveResult ??= input.finishOutput().then(
            () => ({ state: 'complete' as const }),
            (error: unknown) => ({ state: 'failed' as const, error })
          )
          receive = await receiveResult
        }
        const cleanupError =
          physical.root === 'exited'
            ? await input.exitPublication()?.then(
                () => undefined,
                (error: unknown) => error
              )
            : undefined
        return {
          accepted,
          physical,
          processless,
          receive,
          ...(cleanupError === undefined ? {} : { cleanupError })
        }
      })
    attempt = current
    void current.then(
      (outcome) => {
        if (!outcome.accepted && attempt === current) {
          attempt = undefined
        }
      },
      () => {
        if (attempt === current) {
          attempt = undefined
        }
      }
    )
    return current
  }
  return {
    closeOutcome,
    async close() {
      const outcome = await closeOutcome()
      if (outcome.receive.state === 'failed') {
        throw outcome.receive.error
      }
      if (outcome.cleanupError !== undefined) {
        throw outcome.cleanupError
      }
      return outcome.accepted
    }
  }
}

export function codexCloseReport(outcome: CodexCloseOutcome, cause?: unknown): Error | undefined {
  for (const error of [
    ...(outcome.receive.state === 'failed' ? [outcome.receive.error] : []),
    ...(outcome.cleanupError === undefined ? [] : [outcome.cleanupError])
  ]) {
    cause =
      cause === undefined || cause === error
        ? error
        : new AggregateError([cause, error], cause instanceof Error ? cause.message : String(cause))
  }
  if (!outcome.accepted) {
    return new AgentSessionAcquisitionExitUnprovenError(cause ?? new Error('codex close unproven'))
  }
  if (outcome.processless) {
    return new AgentSessionAcquisitionExitProvenError(cause ?? new Error('codex did not start'))
  }
  if (outcome.physical.root !== 'exited') {
    return new AgentSessionAcquisitionRootExitObservedError(
      cause ?? new Error('codex writer killed'),
      'kill-delivered'
    )
  }
  if (
    outcome.physical.tree !== 'exited' ||
    outcome.receive.state === 'failed' ||
    outcome.cleanupError !== undefined
  ) {
    return new AgentSessionAcquisitionRootExitObservedError(
      cause ?? new Error('codex descendant exit unproven')
    )
  }
  return undefined
}
