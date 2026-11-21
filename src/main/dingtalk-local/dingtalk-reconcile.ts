import type { LedgerSnapshot } from './dingtalk-ledger'

export type ReconcileCommand =
  | { kind: 'recover-delivering'; inboxKey: string }
  | { kind: 'deliver'; inboxKey: string }
  | { kind: 'recover-sending'; replyKey: string }
  | { kind: 'send-reply'; replyKey: string }

export type ReconcileLive = { delivering: ReadonlySet<string>; sending: ReadonlySet<string> }

export function reconcileLedger(state: LedgerSnapshot, live: ReconcileLive): ReconcileCommand[] {
  const commands: ReconcileCommand[] = []
  for (const [inboxKey, row] of Object.entries(state.inbox)) {
    if (row.state === 'delivering' && !live.delivering.has(inboxKey)) {
      commands.push({ kind: 'recover-delivering', inboxKey })
    }
    if (row.state === 'pending' && !live.delivering.has(inboxKey)) {
      commands.push({ kind: 'deliver', inboxKey })
    }
  }
  for (const [replyKey, row] of Object.entries(state.replies)) {
    if (row.state === 'sending' && !live.sending.has(replyKey)) {
      commands.push({ kind: 'recover-sending', replyKey })
    }
    if (row.state === 'queued' && !live.sending.has(replyKey)) {
      commands.push({ kind: 'send-reply', replyKey })
    }
  }
  return commands
}
