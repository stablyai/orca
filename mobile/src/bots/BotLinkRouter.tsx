import { BotSessionLinkResolver } from './BotSessionLinkResolver'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Alert } from 'react-native'
import { useRouter } from 'expo-router'
import { PickerModal } from '../components/sheets/PickerModal'
import { hostPickerOptions } from '../host-catalog/selection/use-connected-host-picker'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { getUiIntlLocale } from '../i18n/ui-intl-locale'
import { NewWorkspaceLoadingDrawer } from '../new-workspace/NewWorkspaceLoadingDrawer'
import type { HostProfile } from '../host-catalog/host-profile'
import { redeemBotAccessRequest } from './bot-access-request-redeem'
import {
  accessRequestRefusalLine,
  botLinkMissingLine,
  BOT_LINK_UPDATE_NOTICE,
  botLinkUnreachableLine,
  botLinkUpdateNeededLine
} from './bot-link-copy'
import {
  redeemOnFirstHost,
  resolveAccessRequestNotHere,
  resolveBotLink,
  type BotLinkMatch,
  type BotLinkResolution
} from '../../../src/shared/bots/bot-link-resolution'
import type { BotLinkTarget } from './bot-link-target'
import { botPlaceClient, useOpenBotHome } from './use-open-bot-home'
import type { BotLinkComputerAnswer } from './bot-link-host-reads'
import { LOCAL_EXECUTION_HOST_ID } from '../../../src/shared/execution-host/execution-host'
import {
  clearBotLink,
  continueBotLink,
  isPendingBotLink,
  readPendingBotLink,
  type PendingBotLink,
  subscribeToPendingBotLink
} from './pending-bot-link'
import { useBotLinkHostAnswers } from './use-bot-link-host-answers'

type BotLinkOpen = { computer: BotLinkComputerAnswer; bot: BotLinkMatch['bot'] }

/** Opens `orca://bot/…` links on the computer that lists the bot: a paired host, or a server it
 *  relays, on that paired host's screen. Stays mounted: unmounting would cancel the open. */
export function BotLinkRouter() {
  const link = useSyncExternalStore(subscribeToPendingBotLink, readPendingBotLink)
  const openBotHome = useOpenBotHome()
  const router = useRouter()
  const t = useMobileTranslation()
  const open = useCallback(
    ({ computer, bot }: BotLinkOpen) => openBotHome(computer, bot),
    [openBotHome]
  )
  const showUpdateNeeded = useCallback(
    (hosts: readonly HostProfile[], names: readonly string[]) => {
      if (hosts.length === 1 && names.length === 1) {
        // The host list still shows the bot as a folder there; the line says why the link stopped short.
        router.push({
          pathname: '/h/[hostId]',
          params: { hostId: hosts[0].id, linkNotice: BOT_LINK_UPDATE_NOTICE }
        })
        return
      }
      Alert.alert(
        t('bots.link.updateOrca', 'Update Orca'),
        botLinkUpdateNeededLine(t, names, getUiIntlLocale())
      )
    },
    [router, t]
  )
  const linkId = link?.id
  const done = useCallback(() => {
    if (linkId !== undefined) {
      clearBotLink(linkId)
    }
  }, [linkId])
  const continueWith = useCallback(
    (target: BotLinkTarget) => {
      if (linkId !== undefined) {
        continueBotLink(linkId, target)
      }
    },
    [linkId]
  )
  if (link === null) {
    return null
  }
  const { target } = link
  if (target.kind === 'session') {
    return (
      <BotSessionLinkResolver
        key={link.id}
        link={link}
        target={target}
        onDone={done}
        onFallBack={() =>
          continueWith({ kind: 'bot', botId: target.botId, conversation: target.conversation })
        }
      />
    )
  }
  return (
    <BotLinkResolver
      key={link.id}
      link={link}
      target={target}
      onOpen={open}
      onOpenThread={(hostKey) =>
        target.kind === 'bot' &&
        target.conversation &&
        continueWith({ ...target, kind: 'session', conversation: target.conversation, hostKey })
      }
      onUpdateNeeded={showUpdateNeeded}
      onDone={done}
    />
  )
}

function BotLinkResolver({
  link,
  target,
  onOpen,
  onOpenThread,
  onUpdateNeeded,
  onDone
}: {
  link: PendingBotLink
  target: Exclude<BotLinkTarget, { kind: 'session' }>
  onOpen: (open: BotLinkOpen) => void
  /** A thread link goes on to look up its conversation on the chosen computer, keeping the link. */
  onOpenThread: (hostKey: string) => void
  /** Direct paired hosts too old, and the names of every computer too old. */
  onUpdateNeeded: (hosts: readonly HostProfile[], names: readonly string[]) => void
  onDone: () => void
}) {
  const t = useMobileTranslation()
  const { hosts, answers, computers, clientFor } = useBotLinkHostAnswers()
  const [redeemed, setRedeemed] = useState<BotLinkResolution | null>(null)
  const [pickerOpen, setPickerOpen] = useState(true)
  const pickedRef = useRef<BotLinkMatch | null>(null)
  const redeemStartedRef = useRef(false)
  const settledRef = useRef(false)
  // A redeem answering after Cancel or a newer link must neither alert nor open.
  const liveRef = useRef(true)
  useEffect(() => {
    liveRef.current = true
    return () => {
      liveRef.current = false
    }
  }, [])
  const botResolution = useMemo(
    () => (target.kind === 'bot' && answers ? resolveBotLink(target.botId, answers) : null),
    [target, answers]
  )
  const resolution = target.kind === 'bot' ? botResolution : redeemed
  const thread = target.kind === 'bot' && target.conversation !== undefined
  const hostsById = useMemo(() => new Map(hosts.map((host) => [host.id, host])), [hosts])
  // Answers name computers by key; a relayed server by its own name.
  const nameOf = useCallback(
    (key: string) => {
      const computer = computers.get(key)
      return computer?.serverLabel ?? hostsById.get(computer?.pairedHostId ?? '')?.name
    },
    [computers, hostsById]
  )
  const hostNames = useCallback(
    (keys: readonly string[]) => keys.flatMap((key) => nameOf(key) ?? []),
    [nameOf]
  )
  const toOpen = useCallback(
    (match: BotLinkMatch): BotLinkOpen | null => {
      const computer = computers.get(match.hostId)
      return computer ? { computer, bot: match.bot } : null
    },
    [computers]
  )

  useEffect(() => {
    if (target.kind !== 'access-request' || answers === null || redeemStartedRef.current) {
      return
    }
    redeemStartedRef.current = true
    const redeemingHostIds = answers.flatMap(({ hostId, answer }) =>
      answer.kind === 'bots' ? [hostId] : []
    )
    void redeemOnFirstHost(redeemingHostIds, (key) => {
      const computer = computers.get(key)
      const client = computer && clientFor(computer.pairedHostId)
      return client && computer
        ? redeemBotAccessRequest(botPlaceClient(client, computer), target.token)
        : Promise.resolve({ kind: 'failed' as const })
    }).then((redemption) => {
      if (!liveRef.current) {
        return
      }
      if (redemption.kind === 'not-here') {
        setRedeemed(resolveAccessRequestNotHere(answers))
        return
      }
      if (redemption.kind !== 'redeemed') {
        Alert.alert(
          t('bots.link.openRequestFailed', 'Couldn’t open request'),
          accessRequestRefusalLine(redemption)
        )
        onDone()
        return
      }
      // The request names the bot; open it on the host that took the request.
      setRedeemed(
        resolveBotLink(
          redemption.botId,
          answers.filter(({ hostId }) => hostId === redemption.hostId)
        )
      )
    })
  }, [target, answers, computers, clientFor, onDone, t])

  useEffect(() => {
    if (
      resolution === null ||
      resolution.kind === 'pick' ||
      settledRef.current ||
      !isPendingBotLink(link)
    ) {
      return
    }
    settledRef.current = true
    switch (resolution.kind) {
      case 'open': {
        if (thread) {
          onOpenThread(resolution.match.hostId)
          return
        }
        const opening = toOpen(resolution.match)
        if (opening) {
          onOpen(opening)
        }
        break
      }
      case 'update-needed':
        onUpdateNeeded(
          resolution.hostIds.flatMap((key) => {
            const computer = computers.get(key)
            const direct = computer?.executionHost === LOCAL_EXECUTION_HOST_ID
            return (direct && hostsById.get(computer.pairedHostId)) || []
          }),
          hostNames(resolution.hostIds)
        )
        break
      case 'unreachable':
        Alert.alert(
          t('bots.link.botNotFound', 'Bot not found'),
          botLinkUnreachableLine(t, hostNames(resolution.hostIds), getUiIntlLocale())
        )
        break
      case 'missing':
        Alert.alert(t('bots.link.botNotFound', 'Bot not found'), botLinkMissingLine(t))
    }
    onDone()
  }, [
    resolution,
    link,
    thread,
    computers,
    hostsById,
    hostNames,
    toOpen,
    onOpen,
    onOpenThread,
    onUpdateNeeded,
    onDone,
    t
  ])

  if (resolution?.kind !== 'pick') {
    // The same waiting drawer Home's New Workspace shows over Home; backdrop or drag cancels.
    return (
      <NewWorkspaceLoadingDrawer visible={resolution === null} download={null} onCancel={onDone} />
    )
  }
  const choices = resolution.matches
  return (
    <PickerModal
      title={t('bots.link.openOn', 'Open {{name}} On', { name: choices[0].bot.name })}
      visible={pickerOpen}
      options={choices.flatMap((choice) => {
        const computer = computers.get(choice.hostId)
        const paired = computer && hostsById.get(computer.pairedHostId)
        if (!computer || !paired) {
          return []
        }
        // A relayed server says which paired computer reaches it.
        return computer.serverLabel
          ? [{ value: choice.hostId, label: computer.serverLabel, subtitle: paired.name }]
          : hostPickerOptions([paired]).map((option) => ({ ...option, value: choice.hostId }))
      })}
      selected=""
      onSelect={(hostId) => {
        pickedRef.current = choices.find((choice) => choice.hostId === hostId) ?? null
        setPickerOpen(false)
      }}
      onClose={() => setPickerOpen(false)}
      onAfterClose={() => {
        if (!isPendingBotLink(link)) {
          return
        }
        if (thread && pickedRef.current) {
          onOpenThread(pickedRef.current.hostId)
          return
        }
        const opening = pickedRef.current && toOpen(pickedRef.current)
        if (opening) {
          onOpen(opening)
        }
        onDone()
      }}
    />
  )
}
