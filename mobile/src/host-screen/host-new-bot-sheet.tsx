import { useMemo } from 'react'
import { LOCAL_EXECUTION_HOST_ID } from '../../../src/shared/execution-host/execution-host'
import { MobileNewBotSheet } from '../bots/MobileNewBotSheet'
import { newBotComputers } from '../bots/new-bot-computers'
import { useOpenBotHome } from '../bots/use-open-bot-home'
import { newBotTargetClient } from './new-bot-target-client'
import type { HostScreenController } from './use-host-screen-controller'

/** The Bots header's New bot, made on the computer Runs on picks, then its Home opens as a bot row's does. */
export function HostNewBotSheet({ controller }: { controller: HostScreenController }) {
  const openBotHome = useOpenBotHome()
  const { bots, client, hostCapabilities, hostId, newBot, state } = controller
  const servers = state.serverWorkspaces.hosts
  const computers = useMemo(
    () => newBotComputers({ desktopLabel: state.hostName, listings: bots, serverHosts: servers }),
    [state.hostName, bots, servers]
  )
  const botsOn = (target: string) =>
    bots.flatMap((listing) =>
      listing.kind === 'listed' && listing.hostId === target ? listing.bots : []
    )
  const clientFor = (target: string) =>
    newBotTargetClient({ client, hostCapabilities, target, servers })
  return (
    <MobileNewBotSheet
      visible={newBot.hostId !== null}
      computerId={newBot.hostId}
      computers={computers}
      botsOn={botsOn}
      clientFor={clientFor}
      pairedClientFor={() => clientFor(LOCAL_EXECUTION_HOST_ID)}
      onClose={() => newBot.open(null)}
      onOpenBot={(bot, computer, homeDraft) => {
        newBot.open(null)
        openBotHome({ pairedHostId: hostId, executionHost: computer.hostId }, bot, homeDraft)
      }}
      onCreated={(bot, computer) => {
        newBot.open(null)
        newBot.created()
        openBotHome({ pairedHostId: hostId, executionHost: computer.hostId }, bot)
      }}
    />
  )
}
