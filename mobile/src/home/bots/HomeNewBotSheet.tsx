import { useCallback, useMemo, useState } from 'react'
import { MobileNewBotSheet } from '../../bots/MobileNewBotSheet'
import { botPlaceClient, useOpenBotHome } from '../../bots/use-open-bot-home'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { homeNewBotComputers, type HomeBots } from './home-bot-rows'

/** Home's New bot: the computer's own sheet, with Runs on across every connected computer. Mounted
 *  only from opening until it has closed, so a closed sheet reads and maps nothing. */
export function HomeNewBotSheet(props: {
  visible: boolean
  bots: HomeBots
  clientOf: (pairedHostId: string) => RpcClient | null
  onClose: () => void
}) {
  const [mounted, setMounted] = useState(props.visible)
  if (props.visible && !mounted) {
    setMounted(true)
  }
  const { visible } = props
  const unmount = useCallback(() => {
    if (!visible) {
      setMounted(false)
    }
  }, [visible])
  return mounted ? <OpenHomeNewBotSheet {...props} onAfterClose={unmount} /> : null
}

function OpenHomeNewBotSheet(props: {
  visible: boolean
  bots: HomeBots
  clientOf: (pairedHostId: string) => RpcClient | null
  onClose: () => void
  onAfterClose: () => void
}) {
  const openBotHome = useOpenBotHome()
  const { bots, clientOf } = props
  const computers = useMemo(() => homeNewBotComputers(bots), [bots])
  const byId = useMemo(
    () => new Map(bots.computers.map((computer) => [computer.key, computer])),
    [bots]
  )
  const pairedClientFor = (id: string) => {
    const computer = byId.get(id)
    return computer ? clientOf(computer.pairedHostId) : null
  }
  const clientFor = (id: string) => {
    const computer = byId.get(id)
    const paired = computer ? clientOf(computer.pairedHostId) : null
    return computer && paired ? botPlaceClient(paired, computer) : null
  }
  const botsOn = (id: string) =>
    bots.rows.flatMap((row) => (row.kind === 'bot' && row.computerKey === id ? [row.bot] : []))
  const first = computers.find((computer) => computer.refusal === undefined) ?? null
  return (
    <MobileNewBotSheet
      visible={props.visible}
      computerId={first?.id ?? null}
      computers={computers}
      botsOn={botsOn}
      clientFor={clientFor}
      pairedClientFor={pairedClientFor}
      onClose={props.onClose}
      onAfterClose={props.onAfterClose}
      onOpenBot={(bot, computer) => {
        props.onClose()
        const place = byId.get(computer.id)
        if (place) {
          openBotHome(place, bot)
        }
      }}
      onCreated={(bot, computer) => {
        props.onClose()
        const place = byId.get(computer.id)
        if (place) {
          openBotHome(place, bot)
        }
      }}
    />
  )
}
