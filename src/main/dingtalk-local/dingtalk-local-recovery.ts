import type { DingTalkSetup, ReplyRow } from './dingtalk-domain'
import type { DingTalkLedger } from './dingtalk-ledger'
import { reconcileLedger } from './dingtalk-reconcile'

export async function recoverDingTalkLedger(
  ledger: DingTalkLedger,
  setup: DingTalkSetup | null,
  sendReply: (reply: ReplyRow) => Promise<void>
): Promise<void> {
  const snapshot = ledger.snapshot()
  for (const row of Object.values(snapshot.inbox)) {
    if (row.state === 'delivering') {
      ledger.transitionInbox(row.key, 'delivering', 'pending', {
        reason: 'recovered after restart'
      })
    }
  }
  for (const row of Object.values(snapshot.replies)) {
    if (row.state === 'sending') {
      ledger.transitionReply(row.key, 'sending', 'uncertain', { error: 'recovered after restart' })
    }
  }
  if (!setup?.enabled || !setup.autoReply) {
    return
  }
  for (const row of Object.values(ledger.snapshot().replies)) {
    if (row.state === 'queued') {
      await sendReply(row)
    }
  }
}

export function replayDingTalkInbox(
  ledger: DingTalkLedger,
  setup: DingTalkSetup,
  deliver: (
    inboxKey: string,
    binding: DingTalkSetup['groups'][number],
    row: ReturnType<DingTalkLedger['snapshot']>['inbox'][string]
  ) => Promise<void>
): void {
  const snapshot = ledger.snapshot()
  for (const command of reconcileLedger(snapshot, { delivering: new Set(), sending: new Set() })) {
    if (command.kind !== 'deliver') {
      continue
    }
    const row = snapshot.inbox[command.inboxKey]
    if (!row) {
      continue
    }
    const binding = setup.groups.find(
      (group) => group.profile === row.event.profile && group.groupId === row.event.groupId
    )
    if (binding) {
      void deliver(command.inboxKey, binding, row)
    }
  }
}
