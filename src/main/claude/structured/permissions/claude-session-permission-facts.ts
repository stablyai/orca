import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import type { ClaudeBypassRefusal } from '../claude-structured-session-state'
import type { ClaudeAutoUnsettled } from './claude-full-access-refusal'

/** What this Claude process showed, accepted and refused about permission modes, and the
 *  bookkeeping that keeps a late answer from landing over a newer request. */
export type ClaudeSessionPermissionFacts = {
  startupPermissionMode?: string | null
  firstRootInit?: { permissionMode: string | null; source?: 'initialize' | 'unanswered-auto-ask' }
  actualFirstRootInit?: { permissionMode: string | null; source?: 'unanswered-auto-ask' }
  /** Claude's own effective settings turn bypass off for this process (startup `get_settings`). */
  bypassDisabled?: boolean
  /** Claude accepted a bypass switch in this process, which overrules a start outside it. */
  bypassAccepted?: boolean
  /** Why Claude refused a bypass switch, where one told; a settings read or start says settings. */
  bypassRefusal?: ClaudeBypassRefusal
  /** The latest permission notice, including a warning or Auto recovery from an earlier process. */
  fullAccessRefusalNoticeId?: string
  fullAccessRefusalNotices?: { process: string; count: number; after?: number }
  /** This child ended (closed, exited): its permission writes have no owner. */
  permissionDispatchRevoked?: boolean
  /** Host cuts of this child still held (an admitted close, sleep, quit or ending Stop). */
  permissionDispatchCuts?: number
  /** Counts permission mode requests, so a fallback written after Claude answers never lands
   *  over a newer request. */
  permissionModeRequests?: number
  askAcknowledgedAtReport?: number
  acknowledgedBuildPermissionMode?: PermissionMode
  /** The startup `get_settings` read; settles once its facts are recorded, never rejects. */
  startupSettings?: Promise<void>
  /** Claude's settings turn auto mode off for this process (startup `get_settings`, or a refusal). */
  autoDisabled?: boolean
  autoAccepted?: boolean
  autoRefusedForNow?: boolean
  autoUnansweredAskRequest?: number
  /** Claude last refused auto for a reason that can pass (availability, model, Fast mode), or
   *  left the switch unanswered; says when asking again can get a different answer. */
  autoUnsettled?: ClaudeAutoUnsettled
}
