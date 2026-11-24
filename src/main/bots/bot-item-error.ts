import type { BotItemErrorCode } from '../../shared/bots/bot-items'

/** A refused item write; its code reaches the CLI as `error.code`. */
export class BotItemError extends Error {
  constructor(
    readonly code: BotItemErrorCode,
    message: string,
    readonly data?: unknown
  ) {
    super(message)
    this.name = 'BotItemError'
  }
}
