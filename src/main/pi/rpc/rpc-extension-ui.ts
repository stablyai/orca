import type { AgentJournalStatusItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  AGENT_SESSION_EXTENSION_NOTICE_PRESENTATION,
  AGENT_SESSION_EXTENSION_STATUS_PRESENTATION,
  AGENT_SESSION_EXTENSION_WIDGET_BELOW_PRESENTATION,
  AGENT_SESSION_EXTENSION_WIDGET_PRESENTATION
} from '../../../shared/agent-session/view/agent-session-extension-ui'
import type { JsonlRpcTimelineLane } from '../../jsonl-rpc/timeline-lane'
import type { JsonlRpcRecord } from '../../jsonl-rpc/peer'

/** Pi's fire-and-forget extension UI calls; RPC mode has no terminal of its own to draw them in. */
const EXTENSION_UI_METHODS: ReadonlySet<string> = new Set([
  'notify',
  'setStatus',
  'setWidget',
  'setTitle',
  'set_editor_text'
])

/** A third-party panel is one screenful; a longer one would push the composer away. */
const MAX_WIDGET_LINES = 64
const MAX_LINE_CHARS = 500

const NOTIFY_TONES: Record<string, AgentJournalStatusItem['tone']> = {
  info: undefined,
  warning: 'warning',
  error: 'error'
}

function boundedLine(value: string): string {
  return value.length > MAX_LINE_CHARS ? `${value.slice(0, MAX_LINE_CHARS)}…` : value
}

function widgetText(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  return value
    .filter((line): line is string => typeof line === 'string')
    .flatMap((line) => line.split('\n'))
    .slice(0, MAX_WIDGET_LINES)
    .map(boundedLine)
    .join('\n')
}

/** A keyed row this child wrote, and the value it last wrote, so repeats cost no journal revision. */
type KeyedRow = { presentation: string; text: string }

export class PiRpcExtensionUi {
  private notices = 0
  /** Every keyed row this child wrote, so closing it leaves none of its panels behind. */
  private readonly statuses = new Map<string, KeyedRow>()
  private readonly widgets = new Map<string, KeyedRow>()

  constructor(
    private readonly lane: JsonlRpcTimelineLane,
    private readonly generation: string
  ) {}

  /** Consumes one frame of pi's extension UI sub-protocol; false for anything else, including dialogs. */
  receive(frame: JsonlRpcRecord): boolean {
    if (typeof frame.method !== 'string' || !EXTENSION_UI_METHODS.has(frame.method)) {
      return false
    }
    if (frame.method === 'notify') {
      this.notify(
        typeof frame.message === 'string' ? frame.message : '',
        typeof frame.notifyType === 'string' ? frame.notifyType : 'info'
      )
    } else if (frame.method === 'setStatus' && typeof frame.statusKey === 'string') {
      this.setKeyed({
        rows: this.statuses,
        key: `status:${frame.statusKey}`,
        presentation: AGENT_SESSION_EXTENSION_STATUS_PRESENTATION,
        text: typeof frame.statusText === 'string' ? frame.statusText : undefined
      })
    } else if (frame.method === 'setWidget' && typeof frame.widgetKey === 'string') {
      this.setKeyed({
        rows: this.widgets,
        key: `widget:${frame.widgetKey}`,
        presentation:
          frame.widgetPlacement === 'belowEditor'
            ? AGENT_SESSION_EXTENSION_WIDGET_BELOW_PRESENTATION
            : AGENT_SESSION_EXTENSION_WIDGET_PRESENTATION,
        text: widgetText(frame.widgetLines)
      })
    }
    // setTitle writes the terminal's own title and set_editor_text its editor: Orca's chat owns both
    // (the tab title, the composer draft), and no host channel lets a child claim them yet.
    return true
  }

  /** The child exited: its keyed rows can never be updated again, so none of them keeps drawing. */
  end(): void {
    for (const [item, row] of [...this.statuses, ...this.widgets]) {
      if (row.text.length > 0) {
        this.write(item, row.presentation, '')
      }
    }
    this.statuses.clear()
    this.widgets.clear()
  }

  private notify(message: string, notifyType: string): void {
    const text = boundedLine(message)
    if (text.length === 0) {
      return
    }
    const tone = NOTIFY_TONES[notifyType]
    const body: AgentJournalStatusItem = tone
      ? { kind: 'status', text, presentation: AGENT_SESSION_EXTENSION_NOTICE_PRESENTATION, tone }
      : { kind: 'status', text, presentation: AGENT_SESSION_EXTENSION_NOTICE_PRESENTATION }
    this.lane.apply([
      { type: 'item.update', item: `${this.generation}:notice:${++this.notices}`, body }
    ])
  }

  /** Pi clears a key by sending it without its value; an empty row is how a host forgets it. */
  private setKeyed(input: {
    rows: Map<string, KeyedRow>
    key: string
    presentation: string
    text: string | undefined
  }): void {
    const held = input.rows.get(input.key)
    if (input.text === undefined) {
      input.rows.delete(input.key)
      if (held && held.text.length > 0) {
        this.write(input.key, held.presentation, '')
      }
      return
    }
    if (held?.text === input.text && held.presentation === input.presentation) {
      return
    }
    input.rows.set(input.key, { presentation: input.presentation, text: input.text })
    this.write(input.key, input.presentation, input.text)
  }

  private write(item: string, presentation: string, text: string): void {
    this.lane.apply([{ type: 'item.update', item, body: { kind: 'status', text, presentation } }])
  }
}
