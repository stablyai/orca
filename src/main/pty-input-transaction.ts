import { AGENT_PROMPT_BRACKETED_PASTE_END } from '../shared/agent-prompt-injection'
import {
  canQueueQueryReply,
  enqueueQueryReply,
  flushQueryReplies,
  writeQueuedQueryReply,
  nextPasteState,
  isPtyInputTransactionQueryReply
} from './pty-input-transaction-state'
export { isPtyInputTransactionQueryReply } from './pty-input-transaction-state'
import {
  createTransactionToken,
  invalidateLazyGenerations,
  invalidateOwner,
  pruneLazyTokens,
  releaseLazyToken,
  releaseOwnerToken,
  releaseDormantOwner,
  transactionForToken,
  invalidateTransactionToken
} from './pty-input-transaction-lifecycle'
import type { TransactionToken } from './pty-input-transaction-lifecycle'
export type PtyInputTransactionKind = 'agent-prompt' | 'automation' | 'interactive'
export type PtyInputInvalidationReason = 'terminal_handle_stale' | 'terminal_input_superseded'
export type PtyInputWriteResult = boolean | Promise<boolean>
export type PtyInputTransaction = Readonly<{
  write: (data: string) => PtyInputWriteResult
  invalidated: Promise<PtyInputInvalidationReason>
  readonly active: boolean
  readonly invalidationReason: PtyInputInvalidationReason | null
  release: () => void
}>
type PtyInputWriter = (ptyId: string, data: string) => boolean
type SettledPtyInputWriter = (ptyId: string, data: string) => PtyInputWriteResult
type InputOwner = {
  generation: number | null
  kind: PtyInputTransactionKind
  tokens: Set<TransactionToken>
  pasteOpen: boolean
  pasteMutationPending: boolean
  pendingQueryReplies: string[]
  pendingQueryReplyCodeUnits: number
}
export class PtyInputTransactionOwner {
  private readonly ownerByPtyId = new Map<string, InputOwner>()
  private readonly lazyInteractiveByPtyId = new Map<string, Set<TransactionToken>>()
  constructor(
    private readonly writeInput: PtyInputWriter,
    private readonly writeInputWithSettlement: SettledPtyInputWriter = writeInput
  ) {}
  write(ptyId: string, data: string): boolean {
    const owner = this.ownerByPtyId.get(ptyId)
    if (!owner) {
      return this.writeInput(ptyId, data)
    }
    if (isPtyInputTransactionQueryReply(data)) {
      if (!owner.pasteOpen && !owner.pasteMutationPending) {
        return writeQueuedQueryReply(owner, data, (reply) => this.writeInput(ptyId, reply))
      }
      if (canQueueQueryReply(owner, data)) {
        enqueueQueryReply(owner, data)
        return true
      }
    }
    if (owner.kind === 'interactive') {
      return false
    }
    if (!this.interruptOwner(ptyId, owner)) {
      return false
    }
    return this.writeInput(ptyId, data)
  }
  begin(
    ptyId: string,
    generation: number,
    kind: PtyInputTransactionKind = 'agent-prompt'
  ): PtyInputTransaction | null {
    if (kind === 'interactive') {
      if (generation !== null) {
        invalidateLazyGenerations(
          this.lazyInteractiveByPtyId,
          ptyId,
          generation,
          undefined,
          invalidateTransactionToken,
          'terminal_handle_stale'
        )
      }
      return this.beginLazyInteractive(ptyId, generation)
    }
    const existing = this.ownerByPtyId.get(ptyId)
    if (
      existing &&
      releaseDormantOwner(existing, (state) =>
        flushQueryReplies(state, (reply) => this.writeInput(ptyId, reply))
      )
    ) {
      this.ownerByPtyId.delete(ptyId)
    }
    if (this.ownerByPtyId.has(ptyId)) {
      return null
    }
    invalidateLazyGenerations(
      this.lazyInteractiveByPtyId,
      ptyId,
      generation,
      undefined,
      invalidateTransactionToken,
      'terminal_handle_stale'
    )
    const owner: InputOwner = {
      generation,
      kind,
      tokens: new Set(),
      pasteOpen: false,
      pasteMutationPending: false,
      pendingQueryReplies: [],
      pendingQueryReplyCodeUnits: 0
    }
    this.ownerByPtyId.set(ptyId, owner)
    return this.joinOwner(ptyId, owner)
  }
  beginUnversionedInteractive(ptyId: string): PtyInputTransaction {
    return this.beginLazyInteractive(ptyId, null)
  }
  acknowledgeGeneration(ptyId: string, generation: number): void {
    const owner = this.ownerByPtyId.get(ptyId)
    if (owner && (owner.generation === null || owner.generation !== generation)) {
      invalidateOwner(this.ownerByPtyId, ptyId, owner, 'terminal_handle_stale', (token, reason) =>
        invalidateTransactionToken(token, reason)
      )
    }
    for (const token of this.lazyInteractiveByPtyId.get(ptyId) ?? []) {
      if (token.active && (token.generation === null || token.generation !== generation)) {
        invalidateTransactionToken(token, 'terminal_handle_stale')
      }
    }
    pruneLazyTokens(this.lazyInteractiveByPtyId, ptyId)
  }
  private beginLazyInteractive(ptyId: string, generation: number | null): PtyInputTransaction {
    const token = createTransactionToken(generation)
    const lazy = this.lazyInteractiveByPtyId.get(ptyId) ?? new Set<TransactionToken>()
    lazy.add(token)
    this.lazyInteractiveByPtyId.set(ptyId, lazy)
    let joinedOwner: InputOwner | null = null
    return transactionForToken(token, {
      write: (data) => {
        if (!token.active) {
          return false
        }
        if (!joinedOwner) {
          joinedOwner = this.claimInteractive(ptyId, generation, token)
          if (!joinedOwner) {
            return false
          }
        }
        return this.writeOwned(ptyId, joinedOwner, token, data)
      },
      release: () => {
        if (joinedOwner) {
          this.releaseOwnerToken(ptyId, joinedOwner, token)
        } else {
          releaseLazyToken(this.lazyInteractiveByPtyId, ptyId, token, true)
        }
      }
    })
  }
  private claimInteractive(
    ptyId: string,
    generation: number | null,
    lazyToken: TransactionToken
  ): InputOwner | null {
    const current = this.ownerByPtyId.get(ptyId)
    if (
      current &&
      current.generation !== null &&
      generation !== null &&
      current.generation !== generation
    ) {
      releaseLazyToken(this.lazyInteractiveByPtyId, ptyId, lazyToken, false)
      invalidateTransactionToken(lazyToken, 'terminal_handle_stale')
      return null
    }
    if (current && current.kind !== 'interactive' && !this.interruptOwner(ptyId, current)) {
      return null
    }
    let owner = this.ownerByPtyId.get(ptyId)
    if (!owner) {
      owner = {
        generation,
        kind: 'interactive',
        tokens: new Set(),
        pasteOpen: false,
        pasteMutationPending: false,
        pendingQueryReplies: [],
        pendingQueryReplyCodeUnits: 0
      }
      this.ownerByPtyId.set(ptyId, owner)
      if (generation !== null) {
        invalidateLazyGenerations(
          this.lazyInteractiveByPtyId,
          ptyId,
          generation,
          lazyToken,
          invalidateTransactionToken,
          'terminal_handle_stale'
        )
      }
    }
    if (
      owner.kind !== 'interactive' ||
      (owner.generation !== null && generation !== null && owner.generation !== generation)
    ) {
      return null
    }
    releaseLazyToken(this.lazyInteractiveByPtyId, ptyId, lazyToken, false)
    owner.tokens.add(lazyToken)
    return owner
  }
  private joinOwner(ptyId: string, owner: InputOwner): PtyInputTransaction {
    const token = createTransactionToken(owner.generation)
    owner.tokens.add(token)
    return transactionForToken(token, {
      write: (data) => this.writeOwned(ptyId, owner, token, data),
      release: () => this.releaseOwnerToken(ptyId, owner, token)
    })
  }
  private writeOwned(
    ptyId: string,
    owner: InputOwner,
    token: TransactionToken,
    data: string
  ): PtyInputWriteResult {
    if (!token.active || this.ownerByPtyId.get(ptyId) !== owner || !owner.tokens.has(token)) {
      return false
    }
    const pasteWasOpen = owner.pasteOpen
    const pasteWillBeOpen = nextPasteState(pasteWasOpen, data)
    owner.pasteMutationPending = true
    if (pasteWillBeOpen) {
      owner.pasteOpen = true
    }
    let result: PtyInputWriteResult
    try {
      result =
        owner.kind === 'agent-prompt'
          ? this.writeInputWithSettlement(ptyId, data)
          : this.writeInput(ptyId, data)
    } catch {
      this.finishSettledWrite(ptyId, owner, pasteWasOpen, pasteWillBeOpen, false)
      return false
    }
    if (result instanceof Promise) {
      return result.then(
        (accepted) =>
          this.finishSettledWrite(ptyId, owner, pasteWasOpen, pasteWillBeOpen, accepted),
        () => this.finishSettledWrite(ptyId, owner, pasteWasOpen, pasteWillBeOpen, false)
      )
    }
    return this.finishSettledWrite(ptyId, owner, pasteWasOpen, pasteWillBeOpen, result)
  }
  private finishSettledWrite(
    ptyId: string,
    owner: InputOwner,
    pasteWasOpen: boolean,
    pasteWillBeOpen: boolean,
    accepted: boolean
  ): boolean {
    if (this.ownerByPtyId.get(ptyId) !== owner) {
      return accepted
    }
    owner.pasteMutationPending = false
    owner.pasteOpen = accepted ? pasteWillBeOpen : pasteWasOpen
    if (!owner.pasteOpen) {
      flushQueryReplies(owner, (reply) => this.writeInput(ptyId, reply))
    }
    return accepted
  }
  private interruptOwner(ptyId: string, owner: InputOwner): boolean {
    if (
      (owner.pasteOpen || owner.pasteMutationPending) &&
      !this.writeInput(ptyId, AGENT_PROMPT_BRACKETED_PASTE_END)
    ) {
      return false
    }
    owner.pasteOpen = false
    owner.pasteMutationPending = false
    if (!flushQueryReplies(owner, (reply) => this.writeInput(ptyId, reply))) {
      return false
    }
    invalidateOwner(this.ownerByPtyId, ptyId, owner, 'terminal_input_superseded', (token, reason) =>
      invalidateTransactionToken(token, reason)
    )
    return true
  }
  private releaseOwnerToken = (ptyId: string, owner: InputOwner, token: TransactionToken): void =>
    releaseOwnerToken(this.ownerByPtyId, ptyId, owner, token, (current) =>
      flushQueryReplies(current, (reply) => this.writeInput(ptyId, reply))
    )
}
