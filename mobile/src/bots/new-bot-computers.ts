import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../src/shared/execution-host/execution-host'
import type { MobileRelayHost } from '../../../src/shared/remote-runtime/relay/mobile-relay-hosts-contract'
import { translate } from '../i18n/mobile-i18n'
import type { BotComputerAnswer } from './bot-link-host-reads'
import { hostBotsKey } from './host-bots-read'
import { serverHostDownWord, type HostBotListing, type NewBotRefusal } from './host-bot-listing'

/** A computer New bot's Runs on lists; `refusal` says why it can't take a bot now. */
export type NewBotComputer = {
  /** Unique among the choices: its host id on one paired computer's screen, else `hostBotsKey`. */
  id: string
  hostId: ExecutionHostId
  label: string
  refusal?: string
  /** It makes bots from template packages; otherwise New bot sends a template's seed only. */
  templatePackages?: boolean
}

function updateOrcaOn(host: string): string {
  return translate('bots.list.updateOrcaOn', 'Update Orca on {{host}}', { host })
}

function refusalWords(refusal: NewBotRefusal, label: string, desktopLabel: string): string {
  switch (refusal) {
    case 'bots-off':
      return translate('bots.new.botsOffOn', 'Bots are off on {{host}}', { host: label })
    case 'update':
      return updateOrcaOn(label)
    case 'update-desktop':
      return translate('bots.new.updateDesktopFirst', 'Update Orca on {{host}} first', {
        host: desktopLabel
      })
  }
}

function listingRefusal(
  listing: HostBotListing | undefined,
  label: string,
  desktopLabel: string
): string | undefined {
  if (listing?.kind === 'update-needed') {
    return updateOrcaOn(label)
  }
  if (listing?.kind !== 'listed') {
    // Not read yet, or its read failed: nothing says it takes a bot yet; the list reads it again.
    return translate('bots.new.checking', 'Checking…')
  }
  return listing.createRefusal && refusalWords(listing.createRefusal, label, desktopLabel)
}

/** Runs on's computers: this one first, then each server in the desktop's order, each disabled
 *  with its reason. SSH hosts never reach the phone, so none is listed. */
export function newBotComputers(args: {
  desktopLabel: string
  listings: readonly HostBotListing[]
  serverHosts: readonly MobileRelayHost[]
}): NewBotComputer[] {
  const { desktopLabel, listings } = args
  const listingOf = (hostId: ExecutionHostId) =>
    listings.find((listing) => listing.hostId === hostId)
  const computer = (
    hostId: ExecutionHostId,
    label: string,
    refusal: string | undefined
  ): NewBotComputer => {
    const listing = listingOf(hostId)
    const templatePackages = listing?.kind === 'listed' && listing.takesTemplates === true
    return {
      id: hostId,
      hostId,
      label,
      ...(refusal === undefined ? {} : { refusal }),
      ...(templatePackages ? { templatePackages } : {})
    }
  }
  return [
    computer(
      LOCAL_EXECUTION_HOST_ID,
      desktopLabel,
      listingRefusal(listingOf(LOCAL_EXECUTION_HOST_ID), desktopLabel, desktopLabel)
    ),
    ...args.serverHosts.map((host) =>
      computer(
        host.hostId,
        host.label,
        host.relay === 'update-needed'
          ? updateOrcaOn(host.label)
          : (serverHostDownWord(host) ??
              listingRefusal(listingOf(host.hostId), host.label, desktopLabel))
      )
    )
  ]
}

/** Why a computer that answered takes no new bot from this phone; undefined when it takes one. */
function answerRefusal(
  answer: BotComputerAnswer['answer'],
  label: string,
  desktop: { label: string; takesCreate: boolean } | null
): string | undefined {
  if (answer.kind === 'no-capability') {
    return updateOrcaOn(label)
  }
  if (answer.kind === 'unreachable') {
    return translate('bots.list.offline', 'Offline')
  }
  if (answer.kind !== 'bots') {
    return translate('bots.new.checking', 'Checking…')
  }
  const refusal: NewBotRefusal | undefined = !answer.enabled
    ? 'bots-off'
    : !answer.takesCreate
      ? 'update'
      : desktop && !desktop.takesCreate
        ? 'update-desktop'
        : undefined
  return refusal && refusalWords(refusal, label, desktop?.label ?? label)
}

/** Runs on's computers across paired computers, in Home's order: each computer, then the servers it
 *  relays. `labelOf` names a computer as Home's rows do. */
export function pairedNewBotComputers(
  computers: readonly BotComputerAnswer[],
  labelOf: (computer: BotComputerAnswer) => string
): NewBotComputer[] {
  const isOwn = (computer: BotComputerAnswer) => computer.key === hostBotsKey(computer.pairedHostId)
  const own = new Map(
    computers.flatMap((computer) => (isOwn(computer) ? [[computer.pairedHostId, computer]] : []))
  )
  return computers.flatMap((computer): NewBotComputer[] => {
    // The relay inventory's failed read names no computer.
    if (computer.executionHost === LOCAL_EXECUTION_HOST_ID && !isOwn(computer)) {
      return []
    }
    const label = labelOf(computer)
    const desktop =
      computer.executionHost === LOCAL_EXECUTION_HOST_ID
        ? null
        : (() => {
            const paired = own.get(computer.pairedHostId)
            return {
              label: paired ? labelOf(paired) : label,
              takesCreate: paired?.answer.kind === 'bots' && paired.answer.takesCreate
            }
          })()
    const refusal = answerRefusal(computer.answer, label, desktop)
    return [
      {
        id: computer.key,
        hostId: computer.executionHost,
        label,
        ...(refusal === undefined ? {} : { refusal }),
        ...(computer.answer.kind === 'bots' && computer.answer.takesTemplates
          ? { templatePackages: true }
          : {})
      }
    ]
  })
}
