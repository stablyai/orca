import type { AgentStatusIpcPayload } from '../../shared/agent-status/contracts/agent-status-ipc-payload'
import {
  CONNECTOR_TURN_ACTIVITY_LIMITS,
  type ConnectorTurnActivity,
  type ConnectorTurnActivityStep
} from '../../shared/connectors/connector-turn-activity-contract'
import {
  connectorTurnActivityLine,
  connectorTurnActivityStepTitle
} from '../../shared/connectors/connector-turn-activity-line'
import {
  nativeChatTaskListTool,
  type NativeChatTaskList
} from '../../shared/native-chat/input/task-lists/native-chat-task-list'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import type { ConversationPane } from './external-conversation-types'

// A thread's status is one message edited in place: slower than its source's edit limit, and slow
// enough that a burst of quick tools shows as its last.
export const TURN_ACTIVITY_MIN_GAP_MS = 3_000

export type ActivityEvent = ConversationPane & ConnectorTurnActivity

// Only what telling reads, so anything that knows these can stand in for a chat's row and link.
type ActivityRow = Pick<AgentStatusIpcPayload, 'state' | 'mainAgent' | 'toolName' | 'toolInput'>
type ActivityLink = {
  link: Pick<ExternalConversationLink, 'source' | 'externalId' | 'paneKey' | 'sessionId'>
  workspace: { worktreeId: string }
}

type Told = { turnId: number; said: string; at: number; steps?: ConnectorTurnActivityStep[] }

function stepsOf(list: NativeChatTaskList | null): ConnectorTurnActivityStep[] | undefined {
  const steps = list?.tasks
    .slice(0, CONNECTOR_TURN_ACTIVITY_LIMITS.maxActivitySteps)
    .map((task) => ({ title: connectorTurnActivityStepTitle(task.content), status: task.status }))
  return steps?.length ? steps : undefined
}

/**
 * What each told turn is doing now, told to its conversation as the status row changes: at once
 * when the last word is old enough, else once the gap has passed, as whatever the row says then.
 * A turn that ended is no longer told, so a word still waiting for its gap never goes. Its plan is
 * read when the row shows the agent writing it, and told with every word after.
 */
export class ConversationTurnActivity {
  private readonly told = new Map<string, Told>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  // The plan-tool call each chat's plan was last read for, so one call is one read.
  private readonly planRead = new Map<string, string>()
  // Each chat's newest plan read, numbered across the teller's whole life (a cleared teller is
  // watched again): one that answers after a later one began is out of date.
  private readonly planReads = new Map<string, number>()
  private planReadCount = 0

  constructor(
    private readonly deps: {
      emit: (event: ActivityEvent) => void
      readHookRow: (paneKey: string) => ActivityRow | null
      /** The chat's running turn, once its conversation was told it started. */
      toldTurn: (paneKey: string) => number | null
      linkedFor: (paneKey: string) => ActivityLink | null
      /** The plan the chat's running turn last wrote (its todo list); null with none. */
      turnPlan?: (sessionId: string) => Promise<NativeChatTaskList | null>
      now?: () => number
    }
  ) {}

  observe(paneKey: string): void {
    const turnId = this.deps.toldTurn(paneKey)
    const linked = turnId === null ? null : this.deps.linkedFor(paneKey)
    if (turnId === null || !linked) {
      this.forget(paneKey)
      return
    }
    const row = this.deps.readHookRow(paneKey)
    if (!row || (row.mainAgent ?? row).state !== 'working') {
      return
    }
    this.readPlan(paneKey, turnId, linked.link.sessionId, row)
    const text = connectorTurnActivityLine(row.toolName, row.toolInput)
    const last = this.told.get(paneKey)
    const sameTurn = last?.turnId === turnId
    const steps = sameTurn ? last.steps : undefined
    const said = JSON.stringify([text, steps])
    if (sameTurn ? last.said === said : text === undefined) {
      return
    }
    const now = (this.deps.now ?? Date.now)()
    const wait = sameTurn ? last.at + TURN_ACTIVITY_MIN_GAP_MS - now : 0
    if (wait > 0) {
      if (!this.timers.has(paneKey)) {
        this.timers.set(
          paneKey,
          setTimeout(() => {
            this.timers.delete(paneKey)
            this.observe(paneKey)
          }, wait)
        )
      }
      return
    }
    this.told.set(paneKey, { turnId, said, at: now, ...(steps ? { steps } : {}) })
    this.deps.emit({
      kind: 'activity',
      conversation: { source: linked.link.source, externalId: linked.link.externalId },
      worktreeId: linked.workspace.worktreeId,
      paneKey: linked.link.paneKey,
      turnId,
      ...(text === undefined ? {} : { text }),
      ...(steps ? { steps } : {})
    })
  }

  /** The row shows the agent writing its plan: the journal has it whole, the row only a preview. */
  private readPlan(paneKey: string, turnId: number, sessionId: string, row: ActivityRow): void {
    if (!nativeChatTaskListTool(row.toolName ?? '')) {
      // Another tool since: the next plan call is a new one, whatever its preview reads.
      this.planRead.delete(paneKey)
      return
    }
    const call = `${turnId}:${row.toolInput ?? ''}`
    if (this.planRead.get(paneKey) === call) {
      return
    }
    this.planRead.set(paneKey, call)
    const read = ++this.planReadCount
    this.planReads.set(paneKey, read)
    void this.deps
      .turnPlan?.(sessionId)
      .then((list) => {
        const last = this.told.get(paneKey)
        if (
          list === null ||
          this.planReads.get(paneKey) !== read ||
          this.deps.toldTurn(paneKey) !== turnId
        ) {
          return
        }
        // Held on the turn's last word (one never said yet waits as nothing said), then told. A
        // plan emptied is a plan gone: its steps stop being told.
        const { steps: _stale, ...kept } = { turnId, said: '', at: 0, ...last }
        const steps = stepsOf(list)
        this.told.set(paneKey, { ...kept, ...(steps ? { steps } : {}) })
        this.observe(paneKey)
      })
      .catch(() => {})
  }

  forget(paneKey: string): void {
    const timer = this.timers.get(paneKey)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.timers.delete(paneKey)
    }
    this.told.delete(paneKey)
    this.planRead.delete(paneKey)
    this.planReads.delete(paneKey)
  }

  clear(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer)
    }
    this.timers.clear()
    this.told.clear()
    this.planRead.clear()
    this.planReads.clear()
  }
}
