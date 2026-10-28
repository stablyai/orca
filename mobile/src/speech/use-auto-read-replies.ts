import { useCallback, useEffect, useRef } from 'react'
import { AppState } from 'react-native'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import { isRecord } from '../../../src/shared/agent-status-child-work-value-guards'
import { withoutNativeChatVisualDirectiveLines } from '../../../src/shared/native-chat/native-chat-visual-directive'
import { useRpcClientContext } from '../transport/client-context'
import type { RpcClient } from '../transport/rpc-client'
import {
  findNewWaits,
  useAnnounceWaits,
  waitAnnouncement,
  type WaitBaseline
} from './agent-wait-announcement'
import { isAutoReadMuted } from './auto-read-mute'
import { useAutoReadRepliesPreference } from './auto-read-preference'
import { useBackgroundReadingPreference, useBackgroundReadingService } from './background-reading'
import { backgroundReadingActive } from './background-reading-state'
import { createChatMessageFeeds, type AgentPane } from './chat-message-feeds'
import {
  chimeBeforeMessage,
  projectNameIntro,
  useChimeMode,
  useProjectNameMode,
  type LastReadMessage
} from './project-name-announcement'
import { useReadScopePreference } from './read-scope-preference'
import { expireHolds, speakReply } from './reply-speaker'
import { recordSpeechDiagnostics } from './speech-diagnostics'

// Why: on screen, the workspace list's worktree.ps cadence; off screen, slower to spare battery.
const FOREGROUND_POLL_MS = 3_000
const BACKGROUND_POLL_MS = 15_000

export type ReplyBaseline = ReadonlyMap<string, string>

export type NewReply = { paneKey: string; message: string }

// Why: a first-seen pane only records its reply, so enabling auto-read or reconnecting never reads
// old replies; subagent replies are steps of the parent's turn, not answers to the user.
export function findNewReplies(
  baseline: ReplyBaseline,
  agents: readonly RuntimeWorktreeAgentRow[]
): { baseline: ReplyBaseline; newReplies: NewReply[] } {
  const next = new Map(baseline)
  const newReplies: NewReply[] = []
  for (const agent of agents) {
    if (agent.parentPaneKey) {
      continue
    }
    // Why: a leftover background task keeps the row `working` after the turn ends; and only `done`,
    // since mid-turn `lastAssistantMessage` can hold tool output rather than a reply.
    const turnState = agent.mainAgent?.state ?? agent.state
    const finished =
      turnState === 'done' && agent.lastAssistantMessage ? agent.lastAssistantMessage : null
    const seen = next.get(agent.paneKey)
    if (seen === undefined) {
      next.set(agent.paneKey, finished ?? '')
      continue
    }
    if (finished && finished !== seen) {
      next.set(agent.paneKey, finished)
      newReplies.push({ paneKey: agent.paneKey, message: finished })
    }
  }
  return { baseline: next, newReplies }
}

export type AutoReadAgentRow = RuntimeWorktreeAgentRow & {
  rawPaneKey: string
  worktreeId: string | null
  /** Repo or folder-workspace name, said before a message. */
  project: string | null
}

function worktreeProjectName(worktree: Record<string, unknown>): string | null {
  const name =
    typeof worktree.repo === 'string' && worktree.repo ? worktree.repo : worktree.displayName
  return typeof name === 'string' && name ? name : null
}

// Why: pane keys are only unique within one host, so they get the host id as a prefix.
export function agentRowsFromWorktreePs(hostId: string, result: unknown): AutoReadAgentRow[] {
  const worktrees = isRecord(result) ? result.worktrees : undefined
  if (!Array.isArray(worktrees)) {
    return []
  }
  const rows: AutoReadAgentRow[] = []
  for (const worktree of worktrees) {
    if (!isRecord(worktree) || !Array.isArray(worktree.agents)) {
      continue
    }
    const { worktreeId } = worktree
    const project = worktreeProjectName(worktree)
    for (const entry of worktree.agents) {
      if (!isRecord(entry) || typeof entry.paneKey !== 'string') {
        continue
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the host builds worktree.ps rows from this type; paneKey, the field the reader keys on, is checked above.
      const agent = entry as RuntimeWorktreeAgentRow
      rows.push({
        ...agent,
        paneKey: `${hostId}:${agent.paneKey}`,
        parentPaneKey: agent.parentPaneKey ? `${hostId}:${agent.parentPaneKey}` : null,
        rawPaneKey: agent.paneKey,
        worktreeId: typeof worktreeId === 'string' ? worktreeId : null,
        project
      })
    }
  }
  return rows
}

function agentPanes(rows: readonly AutoReadAgentRow[]): AgentPane[] {
  return rows.flatMap((row) => {
    if (row.parentPaneKey || !row.worktreeId) {
      return []
    }
    const working = (row.mainAgent?.state ?? row.state) === 'working'
    const turnStartedAt = working ? (row.mainAgent?.stateStartedAt ?? row.stateStartedAt) : null
    return [
      {
        paneKey: row.paneKey,
        rawPaneKey: row.rawPaneKey,
        worktreeId: row.worktreeId,
        turnStartedAt
      }
    ]
  })
}

async function readAgentRows(hostId: string, client: RpcClient): Promise<AutoReadAgentRow[]> {
  const response = await client.sendRequest('worktree.ps', {})
  if (!response.ok) {
    throw new Error(`worktree.ps refused: ${response.error.code}`)
  }
  return agentRowsFromWorktreePs(hostId, response.result)
}

// Why: read inside the poll effect, so a changed choice applies without restarting it.
function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value)
  useEffect(() => {
    ref.current = value
  }, [value])
  return ref
}

// Why: runs in the native shell over its own host clients, so auto-read works on any screen.
export function useAutoReadReplies(): void {
  const rpc = useRpcClientContext()
  const { autoRead } = useAutoReadRepliesPreference()
  const { backgroundReading } = useBackgroundReadingPreference()
  const readScopeRef = useLatest(useReadScopePreference().readScope)
  const projectNameModeRef = useLatest(useProjectNameMode().value)
  const chimeModeRef = useLatest(useChimeMode().value)
  const announceWaitsRef = useLatest(useAnnounceWaits().value)
  const baselineRef = useRef<ReplyBaseline>(new Map())
  // Why: JS timers stop off screen, so the background service's ticks drive the poll through this.
  const pollRef = useRef<() => void>(() => undefined)
  const onServiceTick = useCallback(() => pollRef.current(), [])
  useBackgroundReadingService(autoRead && backgroundReading, onServiceTick)

  useEffect(() => {
    if (!autoRead) {
      return
    }
    // Why: fresh baselines, so replies and waits from while auto-read was off are not read out.
    baselineRef.current = new Map()
    let cancelled = false
    let inFlight = false
    let lastPollAt = 0
    let projectByPane: ReadonlyMap<string, string | null> = new Map()
    let lastRead: LastReadMessage | null = null
    let waitBaseline: WaitBaseline = new Map()
    const speakAutoRead = (id: string, paneKey: string, text: string) => {
      const project = projectByPane.get(paneKey) ?? null
      const now = Date.now()
      const intro = {
        chime: chimeBeforeMessage(chimeModeRef.current, project, lastRead, now),
        name: projectNameIntro(projectNameModeRef.current, project, lastRead, now),
        title: project
      }
      lastRead = { project, at: now }
      speakReply(id, text, 'queue', intro)
    }
    const readsEveryMessage = () =>
      readScopeRef.current === 'all' ||
      (readScopeRef.current === 'all-on-screen' && AppState.currentState === 'active')
    const feeds = createChatMessageFeeds((paneKey, messageId, text) => {
      if (!readsEveryMessage() || isAutoReadMuted()) {
        return false
      }
      speakAutoRead(`${paneKey}#${messageId}`, paneKey, text)
      return true
    })

    const poll = async () => {
      const now = Date.now()
      expireHolds(now)
      const onScreen = AppState.currentState === 'active'
      if (!onScreen && !backgroundReadingActive()) {
        return
      }
      // Why: the interval and the service ticks both land here; one read per window is enough.
      const interval = onScreen ? FOREGROUND_POLL_MS : BACKGROUND_POLL_MS
      if (inFlight || now - lastPollAt < interval - 500) {
        return
      }
      inFlight = true
      lastPollAt = now
      try {
        const known = rpc.getAllClients()
        const connected = known.filter(({ client }) => client.getState() === 'connected')
        let lastError: string | null = null
        const rows = await Promise.all(
          connected.map(({ hostId, client }) =>
            readAgentRows(hostId, client).catch((error: unknown) => {
              lastError = error instanceof Error ? error.message : String(error)
              return null
            })
          )
        )
        if (cancelled) {
          return
        }
        // Why: a failed host is skipped, not taken as agentless, so its panes keep their baseline.
        const agents = rows.flatMap((hostRows) => hostRows ?? [])
        // Why: merged, so a host whose read failed this round keeps its panes' projects.
        projectByPane = new Map([
          ...projectByPane,
          ...agents.map((row) => [row.paneKey, row.project] as const)
        ])
        const { baseline, newReplies } = findNewReplies(baselineRef.current, agents)
        baselineRef.current = baseline
        recordSpeechDiagnostics({
          lastPollAt: Date.now(),
          knownHosts: known.length,
          connectedHosts: connected.length,
          agentRows: agents.length,
          newReplies: newReplies.length,
          ...(newReplies.length > 0 ? { lastNewReplyAt: Date.now() } : {}),
          ...(lastError ? { lastError } : {})
        })
        for (const reply of newReplies) {
          const message = withoutNativeChatVisualDirectiveLines(reply.message)
          // Why: the feed already reads this pane's messages, the final one included.
          if (
            isAutoReadMuted() ||
            feeds.heard(reply.paneKey, message) ||
            (readsEveryMessage() && feeds.covers(reply.paneKey))
          ) {
            continue
          }
          speakAutoRead(reply.paneKey, reply.paneKey, message)
        }
        const waits = findNewWaits(waitBaseline, agents)
        waitBaseline = waits.baseline
        if (announceWaitsRef.current === 'on' && !isAutoReadMuted()) {
          for (const wait of waits.newWaits) {
            const id = `${wait.paneKey}~wait~${wait.since}`
            speakAutoRead(id, wait.paneKey, waitAnnouncement(wait.kind))
          }
        }
        if (readScopeRef.current === 'replies') {
          feeds.closeAll()
        } else {
          await Promise.all(
            connected.map(({ hostId, client }, index) => {
              const hostRows = rows[index]
              return hostRows
                ? feeds
                    .sync(hostId, client, agentPanes(hostRows), Date.now())
                    .catch(() => undefined)
                : undefined
            })
          )
          // Why: a feed opened while auto-read was being switched off would outlive the cleanup.
          if (cancelled) {
            feeds.closeAll()
          }
        }
      } catch (error) {
        recordSpeechDiagnostics({
          lastPollAt: Date.now(),
          lastError: error instanceof Error ? error.message : String(error)
        })
      } finally {
        inFlight = false
      }
    }

    pollRef.current = () => void poll()
    void poll()
    const timer = setInterval(() => void poll(), FOREGROUND_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
      feeds.closeAll()
      pollRef.current = () => undefined
    }
  }, [autoRead, rpc])
}
