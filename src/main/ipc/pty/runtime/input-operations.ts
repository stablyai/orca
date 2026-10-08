import type { IPtyProvider } from '../../../providers/types'
import type { PtyRuntimeControllerDeps } from './controller-deps'
import { getProviderForPty } from '../provider/registry'
import { ptyOwnership } from '../provider/ownership-state'
import { bindProviderPtyInput } from '../provider/input-binding'
import {
  ptyInputTransactions,
  type PtyInputTransaction
} from '../../../runtime/pty-input-transactions'
import {
  writeRefused,
  writeUnverifiable,
  isSettledWrite,
  type WriteSettlement
} from '../../../../shared/pty-write-settlement'
import type { TerminalInputKind } from '../../../../shared/terminal-input-kind'
import { isTerminalQueryReply } from '../../../../shared/terminal-query-reply'

type RuntimeWriteDeps = Pick<PtyRuntimeControllerDeps, 'runtime'>

export function writePtyFromRuntimeController(
  deps: RuntimeWriteDeps,
  ptyId: string,
  data: string,
  inputKind: TerminalInputKind,
  options?: { transaction?: PtyInputTransaction }
): boolean | Promise<boolean>
export function writePtyFromRuntimeController(
  deps: RuntimeWriteDeps,
  ptyId: string,
  data: string,
  inputKind: TerminalInputKind,
  options: { waitForSettlement: true; transaction?: PtyInputTransaction }
): WriteSettlement | Promise<WriteSettlement>
export function writePtyFromRuntimeController(
  deps: RuntimeWriteDeps,
  ptyId: string,
  data: string,
  inputKind: TerminalInputKind,
  options?: { waitForSettlement?: true; transaction?: PtyInputTransaction }
): boolean | WriteSettlement | Promise<boolean | WriteSettlement> {
  const write = () =>
    options?.waitForSettlement
      ? writePtyProviderFromRuntimeController(deps, ptyId, data, inputKind, {
          waitForSettlement: true
        })
      : writePtyProviderFromRuntimeController(deps, ptyId, data, inputKind)
  if (options?.transaction || (inputKind === 'query-reply' && isTerminalQueryReply(data))) {
    options?.transaction?.beforeWrite()
    return write()
  }
  const failed = (error: unknown): false | WriteSettlement =>
    options?.waitForSettlement
      ? error instanceof Error && error.message === 'partial_write'
        ? writeUnverifiable('partial_write', true)
        : writeRefused('provider_unavailable')
      : false
  try {
    const result = ptyInputTransactions.run(
      bindProviderPtyInput(ptyId),
      (transaction) =>
        options?.waitForSettlement
          ? transaction.writeWithSettlement(data, inputKind)
          : transaction.write(data, inputKind),
      {
        interrupt: data === '\x03',
        rawInput: data === '\x03',
        writer: {
          write: (bytes, kind) => writePtyProviderFromRuntimeController(deps, ptyId, bytes, kind),
          writeWithSettlement: (bytes, kind) =>
            writePtyProviderFromRuntimeController(deps, ptyId, bytes, kind, {
              waitForSettlement: true
            })
        }
      }
    )
    return result instanceof Promise ? result.catch(failed) : result
  } catch (error) {
    return failed(error)
  }
}

function writePtyProviderFromRuntimeController(
  deps: RuntimeWriteDeps,
  ptyId: string,
  data: string,
  inputKind: TerminalInputKind
): boolean
function writePtyProviderFromRuntimeController(
  deps: RuntimeWriteDeps,
  ptyId: string,
  data: string,
  inputKind: TerminalInputKind,
  options: { waitForSettlement: true }
): WriteSettlement | Promise<WriteSettlement>
function writePtyProviderFromRuntimeController(
  deps: RuntimeWriteDeps,
  ptyId: string,
  data: string,
  inputKind: TerminalInputKind,
  options?: { waitForSettlement: true }
): boolean | WriteSettlement | Promise<WriteSettlement> {
  const observeAcceptedInput = (): void => {
    if (inputKind === 'driving' && ptyOwnership.get(ptyId) === null) {
      deps.runtime?.observeClaudeTerminalEvidence?.(ptyId, { kind: 'input', data })
    }
  }
  let provider: IPtyProvider
  try {
    provider = getProviderForPty(ptyId)
  } catch {
    return options?.waitForSettlement ? writeRefused('provider_unavailable') : false
  }
  if (options?.waitForSettlement) {
    // A provider that cannot settle says so before any effect; synthesizing acceptance
    // from the fire-and-forget write is what cleared durable mailbox reservations.
    if (!provider.writeWithSettlement) {
      return writeRefused('provider_cannot_settle')
    }
    deps.runtime?.terminalRunFacts?.recordInput(ptyId, inputKind, data)
    try {
      const result = provider.writeWithSettlement(ptyId, data)
      const observe = (settlement: WriteSettlement): WriteSettlement => {
        if (settlement.outcome === 'accepted') {
          observeAcceptedInput()
        }
        return settlement
      }
      return isSettledWrite(result) ? observe(result) : result.then(observe)
    } catch {
      // A synchronous throw cannot prove the transport took nothing.
      return writeUnverifiable('provider_threw_after_handoff', true)
    }
  }
  deps.runtime?.terminalRunFacts?.recordInput(ptyId, inputKind, data)
  try {
    const accepted = provider.write(ptyId, data) !== false
    if (accepted) {
      observeAcceptedInput()
    }
    return accepted
  } catch {
    return false
  }
}
