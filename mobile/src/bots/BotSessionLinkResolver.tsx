import { useEffect, useEffectEvent, useRef } from 'react'
import { Alert } from 'react-native'
import { useRouter } from 'expo-router'
import { NewWorkspaceLoadingDrawer } from '../new-workspace/NewWorkspaceLoadingDrawer'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useBotLinkHostAnswers } from './use-bot-link-host-answers'
import type { BotSessionLinkTarget } from './bot-link-target'
import {
  abortWhenNotPending,
  botLinkPublishGeneration,
  type PendingBotLink
} from './pending-bot-link'
import type { BotLinkComputerAnswer } from './bot-link-host-reads'
import { readWhileBotLinkConnected } from './bot-link-connection-read'
import { locateBotSessionLink } from './bot-session-link-locate'
import { botHomeWorktreeId, ensureBotHomeChat } from './host-bots-read'
import {
  botLinkAmbiguousLine,
  botLinkMissingLine,
  botLinkOfflineLine,
  botLinkOpenFailureLine,
  botLinkUnreachableLine,
  botLinkUpdateNeededLine
} from './bot-link-copy'
import { openMobileStructuredSession } from '../session/native-chat/agent-session/open-mobile-structured-session'
import { useOpenMobileSession } from '../session/use-open-mobile-session'
import { structuredAgentSessionPaneKey } from '../../../src/shared/agent-session/view/structured-agent-session-projection'
import { resolveBotLink } from '../../../src/shared/bots/bot-link-resolution'

export function BotSessionLinkResolver({
  link,
  target,
  onDone,
  onFallBack
}: {
  /** The pending entry this resolver serves; its work stops once that entry is no longer pending. */
  link: PendingBotLink
  target: BotSessionLinkTarget
  onDone: () => void
  /** A thread link (no session) that several or no computers answer goes on as the plain bot link. */
  onFallBack: () => void
}) {
  const { hosts, answers, computers, clientFor, failed } = useBotLinkHostAnswers()
  const openSession = useOpenMobileSession()
  const router = useRouter()
  const t = useMobileTranslation()
  const activeAttempt = useRef<AbortController | null>(null)
  const readClients = useEffectEvent(clientFor)
  const done = useEffectEvent(onDone)
  const fallBack = useEffectEvent(onFallBack)
  const open = useEffectEvent(openSession)
  const nameOf = useEffectEvent(
    (computer: BotLinkComputerAnswer) =>
      computer.serverLabel ??
      hosts.find((host) => host.id === computer.pairedHostId)?.name ??
      t('bots.link.computer', 'your computer')
  )
  const unavailable = useEffectEvent((message: string) => {
    Alert.alert(t('bots.link.openFailed', 'Couldn’t open this link'), message)
  })
  useEffect(() => {
    if (answers === null) {
      return
    }
    let live = true
    const attempt = new AbortController()
    activeAttempt.current = attempt
    const stopWatching = abortWhenNotPending(link, attempt)
    void (async () => {
      let openingOn: BotLinkComputerAnswer | undefined
      let handedOff = false
      try {
        if (attempt.signal.aborted) {
          return
        }
        if (failed) {
          unavailable(botLinkOpenFailureLine(t, t('bots.link.computer', 'your computer')))
          return
        }
        if (hosts.length === 0) {
          // Pair stays valid after this link is cleared, until a newer link is published.
          const generation = botLinkPublishGeneration()
          Alert.alert(
            t('bots.link.pairTitle', 'Pair a computer'),
            t(
              'bots.link.pairRequired',
              'To open this link, pair this phone with a computer, then open the link again.'
            ),
            [
              { text: t('common.cancel', 'Cancel'), style: 'cancel' },
              {
                text: t('bots.link.pairAction', 'Pair a computer'),
                onPress: () => {
                  if (botLinkPublishGeneration() === generation) {
                    router.push('/pair')
                  }
                }
              }
            ]
          )
          return
        }
        const asked = [...computers.values()].filter(
          (computer) => !target.hostKey || computer.key === target.hostKey
        )
        const found = await locateBotSessionLink(target, asked, readClients, attempt.signal)
        if (!live || attempt.signal.aborted) {
          return
        }
        const thread = !target.sessionId
        if (thread && !target.hostKey && (found.kind === 'missing' || found.kind === 'ambiguous')) {
          handedOff = true
          fallBack()
          return
        }
        // A thread link lands on its bot's Home where that computer can't open the chat.
        const home =
          found.kind === 'home' ||
          (thread && (found.kind === 'update-needed' || found.kind === 'failed'))
            ? found.home
            : undefined
        if (home) {
          openingOn = home.computer
          if (!home.current()) {
            unavailable(
              readClients(home.computer.pairedHostId)?.getState() !== 'connected'
                ? botLinkOfflineLine(t, nameOf(home.computer))
                : botLinkOpenFailureLine(t, nameOf(home.computer))
            )
            return
          }
          await readWhileBotLinkConnected(
            home.client,
            (signal) =>
              ensureBotHomeChat(home.client, home.bot.id, {
                signal,
                timeoutMs: 5000,
                budgetSpansConnect: true,
                failWhenDisconnected: true,
                beforeSend: () => {
                  if (!live || !home.current()) {
                    throw new Error('Opening superseded')
                  }
                }
              }),
            { signal: attempt.signal }
          )
          if (live && !attempt.signal.aborted && home.current()) {
            open({
              hostId: home.computer.pairedHostId,
              executionHost: home.computer.executionHost,
              worktreeId: botHomeWorktreeId(home.bot),
              name: home.bot.name
            })
          }
        } else if (found.kind === 'update-needed') {
          unavailable(
            botLinkUpdateNeededLine(t, [
              found.servingHost
                ? (hosts.find((host) => host.id === found.home.computer.pairedHostId)?.name ??
                  t('bots.link.computer', 'your computer'))
                : nameOf(found.home.computer)
            ])
          )
        } else if (found.kind === 'failed') {
          unavailable(botLinkOpenFailureLine(t, nameOf(found.home.computer)))
        } else if (found.kind === 'open') {
          const { computer, client, sessionId, worktreeId, itemId, current, authority } =
            found.session
          openingOn = computer
          const opened = await openMobileStructuredSession({
            signal: attempt.signal,
            botLinkTarget: authority,
            client,
            current: () => live && current(),
            source: { kind: 'notification', sessionId, worktreeId }
          })
          if (!live || attempt.signal.aborted) {
            return
          }
          if (opened.kind === 'opened' && current()) {
            open({
              hostId: computer.pairedHostId,
              executionHost: computer.executionHost,
              worktreeId: opened.target.worktreeId,
              paneKey: structuredAgentSessionPaneKey(opened.tab.id, sessionId),
              ...(itemId ? { botItem: JSON.stringify({ sessionId, itemId }) } : {})
            })
          } else {
            unavailable(
              readClients(computer.pairedHostId)?.getState() !== 'connected'
                ? botLinkOfflineLine(t, nameOf(computer))
                : botLinkOpenFailureLine(
                    t,
                    nameOf(computer),
                    opened.kind === 'failed' ? opened.failure : undefined
                  )
            )
          }
        } else {
          const unreadable = asked.find((computer) => computer.answer.kind === 'unreadable')
          if (unreadable) {
            unavailable(botLinkOpenFailureLine(t, nameOf(unreadable)))
            return
          }
          const unresolved = resolveBotLink(
            target.botId,
            asked.map((computer) => ({
              hostId: computer.key,
              answer:
                readClients(computer.pairedHostId)?.getState() !== 'connected'
                  ? { kind: 'unreachable' as const }
                  : computer.answer
            }))
          )
          if (unresolved.kind === 'pick') {
            unavailable(
              botLinkAmbiguousLine(
                t,
                unresolved.matches.flatMap(({ hostId }) => {
                  const computer = computers.get(hostId)
                  return computer ? [nameOf(computer)] : []
                })
              )
            )
          } else if (unresolved.kind === 'update-needed' || unresolved.kind === 'unreachable') {
            const named = unresolved.hostIds
              .map((id) => computers.get(id))
              .filter((computer) => computer !== undefined)
            const only = named.length === 1 ? named[0] : undefined
            unavailable(
              unresolved.kind === 'update-needed'
                ? botLinkUpdateNeededLine(t, named.map(nameOf))
                : only && readClients(only.pairedHostId)?.getState() !== 'connected'
                  ? botLinkOfflineLine(t, nameOf(only))
                  : botLinkUnreachableLine(t, named.map(nameOf))
            )
          } else {
            const known =
              unresolved.kind === 'open' ? computers.get(unresolved.match.hostId) : undefined
            unavailable(known ? botLinkOpenFailureLine(t, nameOf(known)) : botLinkMissingLine(t))
          }
        }
      } catch {
        if (live && !attempt.signal.aborted) {
          const name = openingOn ? nameOf(openingOn) : t('bots.link.computer', 'your computer')
          unavailable(
            openingOn && readClients(openingOn.pairedHostId)?.getState() !== 'connected'
              ? botLinkOfflineLine(t, name)
              : botLinkOpenFailureLine(t, name)
          )
        }
      } finally {
        if (live && !attempt.signal.aborted && !handedOff) {
          done()
        }
      }
    })()
    return () => {
      live = false
      stopWatching()
      attempt.abort()
    }
  }, [answers, computers, failed, hosts, link, router, t, target])
  return (
    <NewWorkspaceLoadingDrawer
      visible
      download={null}
      onCancel={() => {
        activeAttempt.current?.abort()
        onDone()
      }}
    />
  )
}
