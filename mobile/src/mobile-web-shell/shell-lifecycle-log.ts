import type { BridgeErrorCapture } from './bridge/bridge-error-capture'
import { gateVerdict } from './mobile-web-shell-gates'
import type {
  MobileWebShellSession,
  MobileWebShellSessionEvent,
  MobileWebShellSessionState
} from './mobile-web-shell-session-contract'
import type { ShellLifecycleLine } from './shell-lifecycle-line-recorder'
import { maskUserText } from './shell-log-path-masking'

/** Session-side shell log lines: reducer steps, one-shot stalls and page-reported failures. */

const BUILD_ID_PREFIX_LENGTH = 8

/**
 * How long a parked waiting state lasts before the log says so. Armed per state object, so for
 * `ready` it starts at activation and outlasts the 10 s ready deadline, which starts at document load.
 */
export const SHELL_STALL_LOG_MS = 15_000

/** What the reducer does not keep but a log line needs; tracked beside the session, log-only. */
export type ShellLogTrace = {
  /** The flow whose cache read answered, so a stall can say whether it waits on the cache. */
  readonly cacheReadFlow: number | null
  readonly openedFrom: 'download' | 'cache' | null
  /** The page's `ready` asks for this document: more than one means it keeps refusing `init`. */
  readonly readyAsks: number
  readonly documentLoaded: boolean
}

export const EMPTY_SHELL_LOG_TRACE: ShellLogTrace = {
  cacheReadFlow: null,
  openedFrom: null,
  readyAsks: 0,
  documentLoaded: false
}

export function traceShellStep(
  trace: ShellLogTrace,
  before: MobileWebShellSession,
  event: MobileWebShellSessionEvent,
  after: MobileWebShellSession
): ShellLogTrace {
  if ('flow' in event && event.flow !== before.flow) {
    return trace
  }
  switch (event.type) {
    case 'cache-read':
      return { ...trace, cacheReadFlow: event.flow }
    case 'activated':
      return {
        ...trace,
        readyAsks: 0,
        documentLoaded: false,
        openedFrom: before.state.kind === 'activating' ? before.state.source : null
      }
    case 'remounted':
    case 'document-started':
      return { ...trace, readyAsks: 0, documentLoaded: false }
    case 'document-loaded':
      return after.state.kind === 'ready' ? { ...trace, documentLoaded: true } : trace
    case 'page-ready':
      return after.state.kind === 'ready' ? { ...trace, readyAsks: trace.readyAsks + 1 } : trace
    case 'gates-changed':
    case 'manifest-read':
    case 'fetch-progress':
    case 'download-staged':
    case 'download-failed':
    case 'shell-failed':
    case 'retry-pressed':
    case 'page-painted':
    case 'page-back-claim':
    case 'page-ready-deadline':
    case 'document-load-deadline':
    case 'layout-changed':
      return trace
  }
}

/** What one reducer step is worth logging; empty for most steps. `trace` is the post-step one. */
export function shellSessionStepLines(
  before: MobileWebShellSession,
  event: MobileWebShellSessionEvent,
  after: MobileWebShellSession,
  trace: ShellLogTrace
): ShellLifecycleLine[] {
  // A superseded flow's result changed nothing and says nothing about this one.
  if ('flow' in event && event.flow !== before.flow) {
    return []
  }
  const lines = [...eventLines(before, event, trace)]
  const transition = transitionLine(before.state, after.state)
  if (transition !== null) {
    lines.push(transition)
  }
  return lines
}

/** The one-shot warning for a session parked in a waiting state, or null when not parked. */
export function shellStallLine(
  state: MobileWebShellSessionState,
  session: Pick<MobileWebShellSession, 'pagePainted' | 'pageReady' | 'gates' | 'flow'>,
  trace: ShellLogTrace
): ShellLifecycleLine | null {
  const seconds = `${SHELL_STALL_LOG_MS / 1000}s`
  switch (state.kind) {
    case 'checking': {
      const gates = session.gates === null ? 'none' : gateVerdict(session.gates).kind
      const cache = trace.cacheReadFlow === session.flow ? 'read' : 'unread'
      return stallLine(
        `Web shell: still checking host after ${seconds}`,
        `gates=${gates} cache=${cache}`
      )
    }
    case 'fetching':
      // Each progress tick is a new state and re-arms the timer, so this means no progress.
      return stallLine(
        `Web shell: download made no progress for ${seconds}`,
        `assets=${state.completedAssets}/${state.totalAssets} bytes=${state.receivedBytes}/${state.totalBytes}`
      )
    case 'activating':
      return stallLine(`Web shell: still activating after ${seconds}`, `source=${state.source}`)
    case 'ready':
      return session.pagePainted
        ? null
        : stallLine(
            `Web shell: page has not drawn after ${seconds}`,
            `build=${buildPrefix(state.buildId)} page ready=${yesNo(session.pageReady)} readyAsks=${trace.readyAsks} documentLoaded=${yesNo(trace.documentLoaded)}`
          )
    case 'route-unavailable':
    case 'wall':
    case 'failed':
    case 'offline':
      return null
  }
}

export function pageFaultLine(error: BridgeErrorCapture): ShellLifecycleLine {
  const firstLine = error.message.split(/\r?\n/, 1)[0] ?? ''
  return pageLine(
    'warn',
    'Web shell: page faulted',
    `${error.category}: ${maskUserText(firstLine)}`
  )
}

/** The profile read behind `init` rejected, so no bridge host can be built for this screen. */
export function hostProfileUnreadableLine(): ShellLifecycleLine {
  return pageLine('warn', 'Web shell: host profile unreadable')
}

function eventLines(
  before: MobileWebShellSession,
  event: MobileWebShellSessionEvent,
  trace: ShellLogTrace
): ShellLifecycleLine[] {
  if (event.type === 'download-failed') {
    const code = event.cause.hostCode === null ? '' : ` code=${event.cause.hostCode}`
    return [
      flowLine('warn', 'Web shell: app download failed', `reason=${event.cause.reason}${code}`)
    ]
  }
  // Every page signal below is only accepted while a generation is on screen.
  if (before.state.kind !== 'ready') {
    return []
  }
  switch (event.type) {
    case 'shell-failed':
      return [pageLine('warn', 'Web shell: page load failed', `reason=${event.reason}`)]
    case 'page-painted':
      // The one line a healthy open writes; `activatedMs` is flow start to activation, not to paint.
      return before.pagePainted
        ? []
        : [
            pageLine(
              'success',
              'Web shell: page painted',
              `source=${trace.openedFrom ?? 'unknown'} build=${buildPrefix(before.state.buildId)} activatedMs=${before.state.elapsedMs}`
            )
          ]
    case 'page-ready-deadline':
      return before.pageReady
        ? []
        : [pageLine('warn', 'Web shell: page never said ready before the deadline')]
    case 'document-load-deadline':
      return before.documentLoaded || before.pageReady
        ? []
        : [pageLine('warn', 'Web shell: document never finished loading before the deadline')]
    case 'document-started':
    case 'document-loaded':
    case 'page-ready':
    case 'gates-changed':
    case 'cache-read':
    case 'manifest-read':
    case 'fetch-progress':
    case 'download-staged':
    case 'activated':
    case 'remounted':
    case 'page-back-claim':
    case 'layout-changed':
    case 'retry-pressed':
      // Healthy-path signals; the paint line or a stall line's detail stands in for them.
      return []
  }
}

function transitionLine(
  before: MobileWebShellSessionState,
  after: MobileWebShellSessionState
): ShellLifecycleLine | null {
  if (before.kind === after.kind) {
    return null
  }
  switch (after.kind) {
    case 'checking':
      return flowLine('info', 'Web shell: checking host')
    case 'offline':
      return flowLine('warn', 'Web shell: host unreachable and no app cached')
    case 'fetching':
      return flowLine(
        'info',
        'Web shell: downloading app',
        `${after.totalAssets} assets, ${after.totalBytes} bytes`
      )
    case 'activating':
      // A cache activation is immediate and shows up as the paint line's source.
      return after.source === 'download'
        ? flowLine('info', 'Web shell: activating app', 'source=download')
        : null
    case 'ready':
      // Logged at paint.
      return null
    case 'route-unavailable':
      return flowLine('warn', 'Web shell: page does not serve this route')
    case 'wall': {
      const side = 'side' in after.verdict ? ` side=${after.verdict.side}` : ''
      return flowLine(
        'warn',
        'Web shell: blocked by version check',
        `reason=${after.verdict.reason}${side}`
      )
    }
    case 'failed':
      return flowLine(
        'error',
        'Web shell: failed',
        `reason=${after.reason} retried=${after.retriedOnce ? 'yes' : 'no'}`
      )
  }
}

function buildPrefix(buildId: string): string {
  return buildId.slice(0, BUILD_ID_PREFIX_LENGTH)
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no'
}

function flowLine(
  level: ShellLifecycleLine['level'],
  message: string,
  detail?: string
): ShellLifecycleLine {
  return { level, code: 'web-shell-flow', message, ...(detail === undefined ? {} : { detail }) }
}

function pageLine(
  level: ShellLifecycleLine['level'],
  message: string,
  detail?: string
): ShellLifecycleLine {
  return { level, code: 'web-shell-page', message, ...(detail === undefined ? {} : { detail }) }
}

function stallLine(message: string, detail: string): ShellLifecycleLine {
  return { level: 'warn', code: 'web-shell-stalled', message, detail }
}
