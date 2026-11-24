import { isLoneStructuredAgentSessionConversationCommand } from '../../../src/shared/agent-session/view/structured-agent-session-composer'
import { useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import * as z from 'zod'
import { commanderAccount, commanderMemoryId } from '../../../src/shared/commander/memory-contract'
import { handoffPrompt, isHandoffPage } from '../../../src/shared/commander/goal-handoff'
import { appendReturnedDraftText } from '../../../src/shared/native-chat/input/drafts/returned-draft-text'
import { botHomeWorktreeId } from '../bots/host-bots-read'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { loadMobileNativeChatDrafts } from '../session/native-chat/composer/drafts/mobile-native-chat-draft-persistence'
import { editMobileNativeChatDraft } from '../session/native-chat/composer/drafts/mobile-native-chat-draft-store'
import { mobileNativeChatScopeKey } from '../session/native-chat/conversation/mobile-native-chat-scope-key'
import { useSessionRouteRequest } from '../session/use-session-route-request'
import { SESSION_PANE_INTENT_PARAM } from '../session/session-pane-intent'
import type { MobileSessionController } from '../session/use-mobile-session-controller'
import { runRpcOperation } from '../transport/rpc/rpc-operation'
import { openCommanderHome } from './open-commander-conversation'
import { phonePageRead } from './phone-memory-rpc'

const referenceSchema = z
  .object({
    account: commanderAccount,
    pageId: commanderMemoryId,
    version: z.number().int().positive(),
    sessionId: z.string().min(1)
  })
  .strict()
function reference(value: string) {
  try {
    const result = referenceSchema.safeParse(JSON.parse(value))
    return result.success && isHandoffPage({ ...result.data, kind: 'note', deleted: false })
      ? result.data
      : null
  } catch {
    return null
  }
}

type HandoffSession = Pick<
  MobileSessionController,
  | 'client'
  | 'hostId'
  | 'worktreeId'
  | 'activeSessionTab'
  | 'showToast'
  | 'connState'
  | 'workspaceServer'
> & {
  nativeChatController: Pick<MobileSessionController['nativeChatController'], 'showNativeChat'>
}

export function useCommanderHandoffArrival(controller: HandoffSession) {
  const arrival = useSessionRouteRequest('goalHandoff', SESSION_PANE_INTENT_PARAM, 'paneKey')
  const [foreground, setForeground] = useState(
    AppState.currentState !== 'inactive' && AppState.currentState !== 'background'
  )
  const consumed = useRef<typeof arrival>(null)
  const { client, hostId, worktreeId, activeSessionTab, showToast, connState } = controller
  const tabId = activeSessionTab?.id
  const sessionId = activeSessionTab?.type === 'agent-session' ? activeSessionTab.sessionId : null
  const showChat = controller.nativeChatController.showNativeChat
  const t = useMobileTranslation()
  const feedback = useRef({ showToast, t })
  feedback.current = { showToast, t }
  useEffect(() => {
    if (!arrival?.value || consumed.current === arrival) {
      return
    }
    const sub = AppState.addEventListener('change', (state) =>
      setForeground(state !== 'inactive' && state !== 'background')
    )
    return () => sub.remove()
  }, [arrival])
  const paired = controller.workspaceServer === undefined
  useEffect(() => {
    if (
      !paired ||
      !foreground ||
      !arrival?.value ||
      consumed.current === arrival ||
      !client ||
      !hostId ||
      !worktreeId ||
      !tabId ||
      !sessionId ||
      !showChat ||
      connState !== 'connected'
    ) {
      return
    }
    const ref = reference(arrival.value)
    if (!ref || ref.sessionId !== sessionId) {
      return
    }
    const abort = new AbortController()
    const scope = mobileNativeChatScopeKey(hostId, worktreeId, tabId)
    if (!scope) {
      return
    }
    const current = () =>
      !abort.signal.aborted &&
      AppState.currentState !== 'inactive' &&
      AppState.currentState !== 'background'
    const receive = async () => {
      if (!current()) {
        return
      }
      const {
        bot,
        sessionId: homeId,
        current: connected
      } = await openCommanderHome(client, abort.signal)
      if (!current() || !connected()) {
        return
      }
      if (homeId !== ref.sessionId || botHomeWorktreeId(bot) !== worktreeId) {
        throw new Error('handoff_destination_changed')
      }
      // Restore prior text and chips before inserting. Fetch the current revision through the
      // phone RPC: it enforces the exact account and the paired-phone sharing switch on each read.
      await loadMobileNativeChatDrafts(hostId, worktreeId)
      if (!current() || !connected()) {
        return
      }
      const { page } = await runRpcOperation(
        client,
        phonePageRead,
        { account: ref.account, pageId: ref.pageId },
        { signal: abort.signal, failWhenDisconnected: true, timeoutMs: 15000 }
      )
      if (!current() || !connected()) {
        return
      }
      if (page.pageId !== ref.pageId || page.version !== ref.version) {
        throw new Error('handoff_version_changed')
      }
      const text = handoffPrompt(page)
      editMobileNativeChatDraft(scope, (prior) => {
        if (isLoneStructuredAgentSessionConversationCommand(prior.trim())) {
          throw new Error('handoff_unsent_command')
        }
        return appendReturnedDraftText(prior, text)
      })
      consumed.current = arrival
    }
    void receive().catch((err: unknown) => {
      if (current()) {
        consumed.current = arrival
        const { t, showToast } = feedback.current
        if (err instanceof Error && err.message === 'handoff_unsent_command') {
          showToast(
            t('commander.handoffCommand', 'Review the unsent command in this chat before resuming.')
          )
        } else {
          showToast(
            t(
              'commander.handoffFailed',
              'Could not load this handoff. Reopen it in Commander Center and try again.'
            )
          )
        }
      }
    })
    return () => abort.abort()
  }, [
    arrival,
    client,
    hostId,
    worktreeId,
    tabId,
    sessionId,
    connState,
    showChat,
    foreground,
    paired
  ])
}
