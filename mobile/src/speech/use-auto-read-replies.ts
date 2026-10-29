import { useCallback, useEffect, useRef } from 'react'
import { AppState } from 'react-native'
import { mainAgentState } from '../../../src/shared/main-agent-status'
import { withoutNativeChatVisualDirectiveLines } from '../../../src/shared/native-chat/native-chat-visual-directive'
import { useRpcClientContext } from '../transport/client-context'
import {
  findNewWaits,
  useAnnounceWaits,
  waitAnnouncement,
  type WaitBaseline
} from './agent-wait-announcement'
import { agentPanes, readAgentRows, type SpokenAgentRow } from './auto-read-agent-rows'
import { useAutoReadRepliesPreference } from './auto-read-preference'
import { useBackgroundReadingPreference, useBackgroundReadingService } from './background-reading'
import { backgroundReadingActive } from './background-reading-state'
import { createChatMessageFeeds } from './chat-message-feeds'
import {
  chimeBeforeMessage,
  projectNameIntro,
  useChimeMode,
  useProjectNameMode,
  type LastReadMessage
} from './project-name-announcement'
import { useReadScopePreference } from './read-scope-preference'
import { expireHolds, speakReply } from './reply-speaker'
import { logSpeechEvent } from './speech-diagnostics'

// Why: on screen, the workspace list's worktree.ps cadence; off screen, slower to spare battery.
const FOREGROUND_POLL_MS = 3_000
const BACKGROUND_POLL_MS = 15_000
// Why: request timeouts are JS timers, which pause off screen, so a poll stuck this long is replaced.
const STUCK_POLL_MS = 60_000

export type ReplyBaseline = ReadonlyMap<string, string>

/** `endedAt` is when the reply's turn ended, by the host's clock. */
export type NewReply = { paneKey: string; message: string; endedAt: number }

// Why: a host's first look only records its panes, so old replies are never read; a later new pane is
// a new agent. A reply is keyed by its turn's end too, so a later turn's same answer is read again.
export function findNewReplies(
  baseline: ReplyBaseline,
  agents: readonly SpokenAgentRow[],
  hostSeenBefore = false
): { baseline: ReplyBaseline; newReplies: NewReply[] } {
  const next = new Map(baseline)
  const newReplies: NewReply[] = []
  for (const agent of agents) {
    // Why: subagent replies are steps of the parent's turn, not answers to the user.
    if (agent.parentPaneKey) {
      continue
    }
    // Why: a leftover background task keeps the row `working` after the turn ends; and only `done`,
    // since mid-turn `lastAssistantMessage` can hold tool output rather than a reply.
    const finished =
      mainAgentState(agent) === 'done' && agent.lastAssistantMessage
        ? agent.lastAssistantMessage
        : null
    const endedAt = agent.mainAgent?.stateStartedAt ?? agent.stateStartedAt
    const key = finished === null ? '' : `${endedAt}\n${finished}`
    const seen = next.get(agent.paneKey)
    if (seen === undefined && !hostSeenBefore) {
      next.set(agent.paneKey, key)
      continue
    }
    if (finished !== null && key !== seen) {
      next.set(agent.paneKey, key)
      newReplies.push({ paneKey: agent.paneKey, message: finished, endedAt })
    } else if (seen === undefined) {
      next.set(agent.paneKey, key)
    }
  }
  return { baseline: next, newReplies }
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
    const hostsSeen = new Set<string>()
    let cancelled = false
    // Why: a poll that replaced a stuck one makes the stuck one's late results stale.
    let generation = 0
    let inFlightSince: number | null = null
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
      if (!readsEveryMessage()) {
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
      // Why: the interval and the service ticks both land here; half an interval dedupes them
      // without skipping a tick that comes a little early.
      const interval = onScreen ? FOREGROUND_POLL_MS : BACKGROUND_POLL_MS
      const busy = inFlightSince !== null && now - inFlightSince < STUCK_POLL_MS
      if (busy || now - lastPollAt < interval / 2) {
        return
      }
      if (inFlightSince !== null) {
        logSpeechEvent('check stuck, starting a new one')
      }
      const run = ++generation
      inFlightSince = now
      lastPollAt = now
      try {
        const known = rpc.getAllClients()
        feeds.keepHosts(new Set(known.map(({ hostId }) => hostId)))
        const connected = known.filter(({ client }) => client.getState() === 'connected')
        const rows = await Promise.all(
          connected.map(({ hostId, client }) => readAgentRows(hostId, client).catch(() => null))
        )
        if (cancelled || run !== generation) {
          return
        }
        // Why: a failed host is skipped, not taken as agentless, so its panes keep their baseline.
        const agents = rows.flatMap((hostRows) => hostRows ?? [])
        // Why: merged, so a host whose read failed this round keeps its panes' projects.
        projectByPane = new Map([
          ...projectByPane,
          ...agents.map((row) => [row.paneKey, row.project] as const)
        ])
        const newReplies: NewReply[] = []
        connected.forEach(({ hostId }, index) => {
          const hostRows = rows[index]
          if (!hostRows) {
            return
          }
          const found = findNewReplies(baselineRef.current, hostRows, hostsSeen.has(hostId))
          baselineRef.current = found.baseline
          hostsSeen.add(hostId)
          newReplies.push(...found.newReplies)
        })
        const feedsReading = readsEveryMessage()
        for (const reply of feeds.overdue(feedsReading)) {
          speakAutoRead(reply.id, reply.paneKey, reply.text)
        }
        for (const reply of newReplies) {
          const message = withoutNativeChatVisualDirectiveLines(reply.message)
          // Why: one id per turn, so a paused reader keeps a pane's earlier reply waiting too.
          const id = `${reply.paneKey}@${reply.endedAt}`
          if (feeds.heard(reply.paneKey, message)) {
            continue
          }
          // Why: the pane's feed reads the final message too (into the queue while auto-read is
          // paused); held, so it is still read should the feed miss it.
          if (feedsReading && feeds.covers(reply.paneKey)) {
            feeds.awaitReply({ id, paneKey: reply.paneKey, text: message })
            continue
          }
          speakAutoRead(id, reply.paneKey, message)
        }
        const waits = findNewWaits(waitBaseline, agents)
        waitBaseline = waits.baseline
        if (announceWaitsRef.current === 'on') {
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
        logSpeechEvent(`check failed: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        if (run === generation) {
          inFlightSince = null
        }
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
