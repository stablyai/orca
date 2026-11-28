import type { ReactNode } from 'react'
import type { BotItem } from '../../../src/shared/bots/bot-items'
import { MobileBotItemSheets, type BotItemSheet } from '../bots/items/MobileBotItemSheets'
import { useBotItemMoves } from '../bots/items/use-bot-item-moves'
import { HostStatusGatesContext } from '../components/host-connection/host-protocol-gates-context'
import { useHostStatusGates } from '../transport/connection/host-status-gates'
import type { RailBotTarget } from './rail-bot-targets'

/** Supplies the target host's protocol gates so item pages and action sheets work outside a host route. */
export function TargetHostGatesProvider({
  target,
  children
}: {
  target: RailBotTarget | null
  children: ReactNode
}): React.JSX.Element {
  const gates = useHostStatusGates({
    hostId: target?.pairedHostId,
    client: target?.client ?? null,
    connState: target?.online ? 'connected' : 'disconnected'
  })
  return <HostStatusGatesContext.Provider value={gates}>{children}</HostStatusGatesContext.Provider>
}

export function TargetItemSheetsHost({
  target,
  sheet,
  setSheet,
  onOpenChat,
  showToast
}: {
  target: RailBotTarget | null
  sheet: BotItemSheet | null
  setSheet: (next: BotItemSheet | null) => void
  onOpenChat: (item: BotItem) => void
  showToast: (message: string) => void
}): React.JSX.Element {
  const moves = useBotItemMoves({
    client: target?.client ?? null,
    hostName: target?.hostName ?? '',
    showToast
  })
  return (
    <MobileBotItemSheets
      sheet={sheet}
      setSheet={setSheet}
      online={target?.online ?? false}
      hostName={target?.hostName ?? ''}
      onSelect={null}
      onOpenChat={onOpenChat}
      move={(moved, to, reason) => moves.move(moved, to, reason)}
      snooze={(snoozed, until) => moves.snooze(snoozed, until)}
    />
  )
}
