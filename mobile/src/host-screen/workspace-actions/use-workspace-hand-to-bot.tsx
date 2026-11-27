import { useEffect, useMemo, useRef, useState } from 'react'
import { chatPaneKey } from '../../../../src/shared/agent-session/view/structured-agent-session-projection'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../src/shared/execution-host/execution-host'
import {
  suggestedBotAgent,
  suggestedBotName,
  suggestedBotPurpose
} from '../../../../src/shared/bots/hand-over-workspace'
import { MobileNewBotSheet } from '../../bots/MobileNewBotSheet'
import type { ListedHostBots } from '../../bots/host-bot-listing'
import { botHomeWorktreeId } from '../../bots/host-bots-read'
import { newBotComputers } from '../../bots/new-bot-computers'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { Worktree } from '../../worktree/workspace-list/workspace-list-types'
import type { HostScreenController } from '../use-host-screen-controller'
import { handToBotFailureLine, handToBotName, handWorkspaceToBot } from './hand-to-bot-operations'
import { WorkspaceHandToBotSheet, type HandToBotSeed } from './workspace-hand-to-bot-sheet'

/** Hand to bot… from the workspace menu: its picker swaps into the menu's drawer, and New bot… opens
 *  the New bot sheet once that drawer has closed, coming back to the picker unless the bot took it. */
export function useWorkspaceHandToBot(args: {
  controller: HostScreenController
  /** Closes the workspace menu's drawer, then runs `then`. */
  closeMenuThen: (then: () => void) => void
}) {
  const { controller, closeMenuThen } = args
  const { bots, client, state } = controller
  const t = useMobileTranslation()
  const [target, setTarget] = useState<Worktree | null>(null)
  const [seed, setSeed] = useState<HandToBotSeed | null>(null)
  const [newBotFor, setNewBotFor] = useState<{ row: Worktree; goal: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const afterNewBot = useRef<(() => void) | null>(null)
  // A late failure reads the menu as it is then, not as it was when Create was tapped.
  const menuOpen = useRef(false)
  useEffect(() => {
    menuOpen.current = state.actionTarget !== null
  }, [state.actionTarget])
  // The paired computer's own bots; its Bots switch, off, offers none, as its menu does.
  const listing = bots.find(
    (entry): entry is ListedHostBots =>
      entry.hostId === LOCAL_EXECUTION_HOST_ID && entry.kind === 'listed'
  )
  const handBots = listing && listing.createRefusal !== 'bots-off' ? listing : null
  const computers = useMemo(
    () =>
      newBotComputers({ desktopLabel: state.hostName, listings: bots, serverHosts: [], t }).filter(
        (computer) => computer.hostId === LOCAL_EXECUTION_HOST_ID
      ),
    [state.hostName, bots, t]
  )

  const reopen = (row: Worktree, next: HandToBotSeed) => {
    setSeed(next)
    setTarget(row)
    state.setActionTarget(row)
  }

  // As a bot's chat row opens it, in its home.
  const openChat = (bot: { name: string; folderWorkspaceId: string }, sessionId: string) =>
    controller.actions.openWorktreeSession(
      { worktreeId: botHomeWorktreeId(bot), displayName: bot.name, repo: bot.name },
      chatPaneKey(sessionId)
    )

  const newBotRow = newBotFor?.row
  const newBotName = newBotRow ? handToBotName(newBotRow) : ''
  const newBotSheet =
    handBots && client ? (
      <MobileNewBotSheet
        visible={newBotFor !== null}
        // None while closed, so the hidden form asks the computer for nothing.
        computerId={newBotFor ? LOCAL_EXECUTION_HOST_ID : null}
        computers={computers}
        botsOn={() => handBots.bots}
        clientFor={() => client}
        pairedClientFor={() => client}
        seed={
          newBotRow
            ? {
                proposal: {
                  name: suggestedBotName(newBotName),
                  purpose: suggestedBotPurpose(newBotRow)
                },
                agent: suggestedBotAgent(
                  (newBotRow.agents ?? []).flatMap((agent) => agent.agentType ?? [])
                ),
                takingOver: true,
                origin: t(
                  'bots.handToBot.newBotOrigin',
                  'From {{name}}. It takes the workspace over when you create it.',
                  { name: newBotName }
                )
              }
            : undefined
        }
        onClose={() => {
          if (newBotFor) {
            const { row, goal } = newBotFor
            afterNewBot.current = () => reopen(row, { goal })
          }
          setNewBotFor(null)
        }}
        onAfterClose={() => {
          const then = afterNewBot.current
          afterNewBot.current = null
          then?.()
        }}
        onCreated={(bot) => {
          if (!newBotFor) {
            return
          }
          const { row, goal } = newBotFor
          setNewBotFor(null)
          controller.newBot.created()
          // The picker comes back with the reason only once this sheet has gone.
          let closed = false
          let failed: (() => void) | null = null
          afterNewBot.current = () => {
            closed = true
            failed?.()
          }
          void handWorkspaceToBot({ client, row, bot, chat: 'home', goal }).then((outcome) => {
            if (outcome.ok) {
              openChat(bot, outcome.sessionId)
              return
            }
            const failure = handToBotFailureLine(outcome, handToBotName(row), bot.name)
            // Only over the list as it was: a menu or sheet opened meanwhile keeps the screen.
            failed = () => {
              if (!menuOpen.current) {
                reopen(row, { goal, made: { bot, failure } })
              }
            }
            if (closed) {
              failed()
            }
          })
        }}
      />
    ) : null

  return {
    /** Null while this computer's Bots are off or unread: the menu offers no Hand to bot…. */
    open:
      handBots && client
        ? (row: Worktree) => {
            setSeed(null)
            setTarget(row)
          }
        : null,
    target,
    /** A hand-over in flight keeps the drawer open, as the desktop's dialog does. */
    busy,
    reset: () => {
      setTarget(null)
      setSeed(null)
    },
    sheet: (row: Worktree, onClose: () => void) =>
      handBots && client ? (
        <WorkspaceHandToBotSheet
          row={row}
          rows={state.worktrees}
          listing={handBots}
          client={client}
          seed={seed}
          onBusy={setBusy}
          onNewBot={(goal) => closeMenuThen(() => setNewBotFor({ row, goal }))}
          onHandedOver={(bot, sessionId) => {
            onClose()
            openChat(bot, sessionId)
          }}
          onClose={onClose}
        />
      ) : null,
    newBotSheet
  }
}
