import type { DingTalkSetup } from './dingtalk-domain'
import type { LedgerSnapshot } from './dingtalk-ledger'

export type DingTalkLocalStatus = {
  enabled: boolean
  configPath: string
  consumers: number
  pendingMessages: number
  pendingReplies: number
  uncertainReplies: number
  lastError: string
}

export function statusOf(input: {
  setup: DingTalkSetup | null
  configPath: string
  consumerCount: number
  ledger: LedgerSnapshot
  lastError: string
}): DingTalkLocalStatus {
  const { ledger } = input
  return {
    enabled: input.setup?.enabled === true,
    configPath: input.configPath,
    consumers: input.consumerCount,
    pendingMessages: Object.values(ledger.inbox).filter(
      (row) => row.state === 'pending' || row.state === 'delivering'
    ).length,
    pendingReplies: Object.values(ledger.replies).filter(
      (row) => row.state === 'queued' || row.state === 'sending'
    ).length,
    uncertainReplies: Object.values(ledger.replies).filter((row) => row.state === 'uncertain')
      .length,
    lastError: input.lastError
  }
}
