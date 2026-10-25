import type {
  TerminalDraftSaveResult,
  TerminalDraftSubmitResult
} from '../../../../shared/terminal-draft-contract'

const OPERATIONS_PER_PTY = 32

function operationKey(ptyId: string, operationId: string): string {
  return `${ptyId}\u0000${operationId}`
}

function rememberBounded<T>(cache: Map<string, T>, key: string, value: T, ptyId: string): void {
  const prefix = `${ptyId}\u0000`
  const keys = [...cache.keys()].filter((candidate) => candidate.startsWith(prefix))
  if (keys.length >= OPERATIONS_PER_PTY) {
    cache.delete(keys[0]!)
  }
  cache.set(key, value)
}

/** Bounded replay answers so a retried save/submit never writes twice while the host is alive. */
export class TerminalDraftOperationCache {
  private readonly saves = new Map<string, TerminalDraftSaveResult>()
  private readonly submits = new Map<string, TerminalDraftSubmitResult>()

  readSave(ptyId: string, operationId: string): TerminalDraftSaveResult | null {
    return this.saves.get(operationKey(ptyId, operationId)) ?? null
  }

  readSubmit(ptyId: string, operationId: string): TerminalDraftSubmitResult | null {
    return this.submits.get(operationKey(ptyId, operationId)) ?? null
  }

  rememberSave(ptyId: string, operationId: string, result: TerminalDraftSaveResult): void {
    rememberBounded(this.saves, operationKey(ptyId, operationId), result, ptyId)
  }

  rememberSubmit(ptyId: string, operationId: string, result: TerminalDraftSubmitResult): void {
    rememberBounded(this.submits, operationKey(ptyId, operationId), result, ptyId)
  }

  dispose(ptyId: string): void {
    const prefix = `${ptyId}\u0000`
    for (const key of this.saves.keys()) {
      if (key.startsWith(prefix)) {
        this.saves.delete(key)
      }
    }
    for (const key of this.submits.keys()) {
      if (key.startsWith(prefix)) {
        this.submits.delete(key)
      }
    }
  }
}
