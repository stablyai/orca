import { extractOnlyTerminalQueryReplies } from '../../../../shared/terminal/protocol/queries/terminal-query-reply'
import type { TerminalInputKind } from '../../../../shared/terminal/input/terminal-input-kind'
import type { IPtyProvider } from '../../../providers/pty/provider-contract'

export function shouldSuppressProviderQueryReply(
  provider: Pick<IPtyProvider, 'ownsTerminalQueryReplies'>,
  kind: TerminalInputKind,
  data: string
): boolean {
  return (
    provider.ownsTerminalQueryReplies === true &&
    kind === 'query-reply' &&
    extractOnlyTerminalQueryReplies(data) !== null
  )
}
