// A chat follows the account selected in Orca's picker: its next start carries the conversation
// to that account, repins the record, and leaves a quiet row saying so.

import { randomUUID } from 'node:crypto'
import {
  AGENT_SESSION_ACCOUNT_SWITCH_FAILED_PRESENTATION,
  AGENT_SESSION_ACCOUNT_SWITCH_PRESENTATION,
  agentSessionAccountSwitchBody,
  agentSessionAccountSwitchFailedBody,
  type AgentSessionAccountSwitch
} from '../../../shared/agent-session-account-switch-row'
import type {
  AgentJournalItemBody,
  AgentJournalPlainStatusItem
} from '../../../shared/agent-session-journal-types'
import {
  agentSessionAccountHomesEqual,
  type AgentSessionAccountHome
} from '../../../shared/agent-session-account-home'
import { activeProviderContext } from '../../../shared/agent-session-provider-context'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import type { StructuredAgentSessionAttachLock } from './structured-agent-session-attach-lock'
import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'

export type StructuredAgentSessionAccountMove = {
  accountHome: AgentSessionAccountHome
  /** The selected account's sign-in email; absent is System default. */
  account?: string
  /** Repin without the row: the chat may already run there. */
  quiet?: true
}

/** A move that failed once it knew both accounts, so the chat can say where it stayed. */
export class StructuredAgentSessionAccountMoveError extends Error {
  constructor(
    readonly accounts: AgentSessionAccountSwitch,
    options: { cause: unknown }
  ) {
    super('moving a chat to the selected account failed', options)
  }
}

/** The execution host's account selection, as a chat sees it. */
export type StructuredAgentSessionAccountFollow = {
  /** The home `record`'s agent would launch in now, read without side effects; null never moves it. */
  selectedHome: (record: AgentSessionRecord) => Promise<AgentSessionAccountHome | null>
  /** Prepares the selected home and carries the conversation there; null leaves the chat where it is. */
  move: (record: AgentSessionRecord) => Promise<StructuredAgentSessionAccountMove | null>
}

/** Whether the chat's child launched on another account than the picker selects now. */
export async function launchedOnOtherAccount(
  deps: Pick<StructuredAgentSessionHostDeps, 'accountFollow' | 'store'>,
  sessionId: string,
  session: Pick<StructuredAgentSessionHostSession, 'accountFollowTried'> | undefined
): Promise<boolean> {
  const record = deps.store.getRecord(sessionId)
  if (!deps.accountFollow || !record) {
    return false
  }
  const selected = await deps.accountFollow.selectedHome(record).catch(() => null)
  const tried = session?.accountFollowTried
  return (
    selected !== null &&
    !agentSessionAccountHomesEqual(selected, record.accountHome) &&
    !(tried && agentSessionAccountHomesEqual(selected, tried))
  )
}

/** Before a start reads its params: a failed move starts on the old account, as before. */
export async function followSelectedAccountBeforeStart(
  context: Pick<StructuredAgentSessionAttachContext, 'deps' | 'sessions'>,
  sessionId: string,
  lock: StructuredAgentSessionAttachLock
): Promise<void> {
  const { deps } = context
  const follow = deps.accountFollow
  const record = deps.store.getRecord(sessionId)
  if (!follow || !record || record.lease.ownerProcess !== null) {
    return
  }
  let moved: StructuredAgentSessionAccountMove | null
  try {
    const selected = await lock.wait(follow.selectedHome(record))
    const session = context.sessions.get(sessionId)
    if (session && selected) {
      session.accountFollowTried = selected
    }
    moved = await lock.wait(follow.move(record))
  } catch (error) {
    deps.logger.warn('moving a chat to the selected account failed', {
      scope: 'account-follow',
      sessionId,
      error
    })
    if (error instanceof StructuredAgentSessionAccountMoveError) {
      const body = agentSessionAccountSwitchFailedBody(error.accounts)
      await lock.commit(async () => {
        // A restart forgets the attempt; the chat already says so if nothing changed since.
        const journal = context.sessions.get(sessionId)?.journal
        if (!journal || newestAccountRowText(journal) !== body.text) {
          await appendAccountRow(context, sessionId, body)
        }
      })
    }
    return
  }
  if (
    !moved ||
    (record.accountHomeConfirmed &&
      agentSessionAccountHomesEqual(moved.accountHome, record.accountHome))
  ) {
    return
  }
  const { accountHome, account, quiet } = moved
  await lock.commit(async () => {
    const current = deps.store.getRecord(sessionId)
    // Another start may have moved or claimed it while the conversation was carried.
    if (
      !current ||
      current.lease.ownerProcess !== null ||
      !agentSessionAccountHomesEqual(current.accountHome, record.accountHome)
    ) {
      return
    }
    await deps.store.repinAccountHome(sessionId, accountHome)
    if (!quiet && activeProviderContext(current).head) {
      await appendAccountRow(context, sessionId, agentSessionAccountSwitchBody(account))
    }
  })
}

function newestAccountRowText(journal: {
  visitItems: (
    visit: (itemId: string, sequence: number, body: AgentJournalItemBody) => void
  ) => void
}): string | undefined {
  let newest: { sequence: number; text: string } | undefined
  journal.visitItems((_itemId, sequence, body) => {
    if (
      body.kind === 'status' &&
      (body.presentation === AGENT_SESSION_ACCOUNT_SWITCH_PRESENTATION ||
        body.presentation === AGENT_SESSION_ACCOUNT_SWITCH_FAILED_PRESENTATION) &&
      (!newest || sequence > newest.sequence)
    ) {
      newest = { sequence, text: body.text }
    }
  })
  return newest?.text
}

async function appendAccountRow(
  context: Pick<StructuredAgentSessionAttachContext, 'deps' | 'sessions'>,
  sessionId: string,
  body: AgentJournalPlainStatusItem
): Promise<void> {
  const { deps } = context
  const journal = context.sessions.get(sessionId)?.journal
  if (!journal) {
    return
  }
  const fence = structuredAgentSessionConversationFence(deps.store, sessionId)
  await journal
    .appendItem({ provider: 'orca', clientMessageId: `account-switch:${randomUUID()}` }, body, {
      fence,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    .catch((error: unknown) =>
      deps.logger.warn('recording a chat account move failed', {
        scope: 'account-follow',
        sessionId,
        error
      })
    )
}
