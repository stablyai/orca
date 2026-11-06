/** A prepared launch's wait for its first turn's final input. The host still owns Setup, the surface
 *  decision and every effect; this gate only holds the execution after Setup until the caller hands it
 *  one immutable input, and ends that wait on release, close, expiry or the launch's own end. It never
 *  supplies choices of its own: an input that never arrives starts nothing. */

import { canonicalAgentSessionDigest } from '../../shared/agent-session/lifecycle/agent-session-mutation-envelope'
import { AgentLaunchClosedBeforeDispatchError } from '../../shared/agent-launch/contracts/agent-launch-tab-closed'
import { formatAgentTypeLabel } from '../../shared/agent-status/presentation/agent-type-label'
import { compileAgentLaunchTerminalAlternative } from '../../shared/agent-launch/startup/agent-launch-terminal-recipe'
import type {
  AgentLaunchStatusResult,
  AgentLaunchTerminalStartupParams
} from '../../shared/rpc-contract/agent-launch-accept-params'
import type {
  AgentLaunchPreparedPromptParams,
  AgentLaunchReleasedInput,
  AgentLaunchTerminalAlternativeParams
} from '../../shared/rpc-contract/agent-launch-release-params'
import type { AgentLaunchPrompt } from '../../shared/agent-launch/contracts/agent-launch-intent'
import type { StructuredAgentSessionFirstMessage } from '../../shared/agent-session/structured-agent-session-create'
import { agentSessionExecutionOptionsRecord } from '../../shared/agent-session/options/agent-session-execution-options'
import { OrchestrationError } from '../runtime/orchestration/orchestration-error'
import { AgentLaunchSurfaceUnavailableError } from './agent-launch-surface-refusal'

export const AGENT_LAUNCH_INPUT_EXPIRED_CODE = 'agent_session_operation_expired'

/** The final input never arrived before the launch's own replay window closed: nothing started. */
export class AgentLaunchInputExpiredError extends OrchestrationError {
  constructor(agent: string) {
    super(
      AGENT_LAUNCH_INPUT_EXPIRED_CODE,
      `${formatAgentTypeLabel(agent)} was not started because its first message was never sent. Send it again in a new chat.`
    )
  }
}

/** The first turn's choices as a terminal takes them: the message's selection over the create options. */
export function releasedTerminalChoices(input: AgentLaunchReleasedInput): Record<string, string> {
  return { ...input.options, ...agentSessionExecutionOptionsRecord(input.selection) }
}

export type AgentLaunchReleasePhase = 'preparing' | 'awaiting-release' | 'released'

/** One digest per complete input, so an identical retry joins and any other input conflicts: a
 *  changed image, file reference or skill conflicts as a changed choice does. */
export function agentLaunchReleaseDigest(input: AgentLaunchReleasedInput): string {
  return canonicalAgentSessionDigest({
    method: 'agent.launchRelease',
    options: input.options,
    optionsMode: input.optionsMode,
    selection: input.selection,
    firstMessage: input.firstMessage
  })
}

/** The released body's text, as a terminal types it; images and skills ride beside it. */
function releasedMessageText(input: AgentLaunchReleasedInput): string {
  return (input.firstMessage?.body.blocks ?? [])
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
}

/** The released body's images, in order. A URL has no host path a terminal could paste: null. */
function releasedMessageImages(input: AgentLaunchReleasedInput): (string | null)[] {
  return (input.firstMessage?.body.blocks ?? []).flatMap((block) =>
    block.type === 'image-ref' ? [block.path ?? null] : []
  )
}

export class AgentLaunchReleaseGate {
  private currentPhase: AgentLaunchReleasePhase = 'preparing'
  private readonly input = Promise.withResolvers<AgentLaunchReleasedInput>()
  private installed: { digest: string; input: AgentLaunchReleasedInput } | undefined
  private compiled: ReturnType<typeof compileAgentLaunchTerminalAlternative> | undefined
  private readonly phaseChanged = Promise.withResolvers<void>()
  private readonly ending = new AbortController()
  private endReason: Error | undefined
  private expiresAt: number | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly onClosed = (): void => this.finish(new AgentLaunchClosedBeforeDispatchError())
  /** The one release admission for this launch, joined by an identical release. */
  admission: { digest: string; answer: Promise<AgentLaunchStatusResult> } | undefined

  constructor(
    readonly terminalAlternative: AgentLaunchTerminalAlternativeParams,
    private readonly agent: string,
    /** The held message prepare named; its body arrives with release. */
    private readonly prompt: AgentLaunchPreparedPromptParams | undefined,
    /** The chat the launch reserved, which uploads made before it exists are for. */
    readonly sessionId: string | undefined,
    private readonly closed: AbortSignal,
    /** The workspace the launch was authorized for; a release is authorized against it again. */
    readonly target: { kind: 'existing'; worktree: string },
    private readonly now: () => number = Date.now
  ) {
    // An input never awaited (Setup failed, or the launch closed first) must not report unhandled.
    void this.input.promise.catch(() => {})
    if (closed.aborted) {
      this.onClosed()
    } else {
      closed.addEventListener('abort', this.onClosed, { once: true })
    }
  }

  /** True only while this live launch waits for an input it has not been handed. */
  get awaitingRelease(): boolean {
    return this.currentPhase === 'awaiting-release' && !this.installed && !this.endReason
  }

  /** True while Setup runs and nothing has yet ended or answered the wait. */
  get preparing(): boolean {
    return this.currentPhase === 'preparing' && !this.installed && !this.endReason
  }

  /** True while this live launch may still take files for its input: nothing installed or ended. */
  takesUploads(): boolean {
    this.expireIfDue()
    return !this.installed && !this.endReason
  }

  /** An input names exactly the message prepare did, under its id, or none when prepare named none. */
  matchesPreparedMessage(input: AgentLaunchReleasedInput): boolean {
    return (input.firstMessage?.clientMessageId ?? null) === (this.prompt?.clientMessageId ?? null)
  }

  /** Settles once the launch is ready for its input, has it, or ends; status reads wake on it. */
  get phaseSignal(): Promise<void> {
    return this.phaseChanged.promise
  }

  /** Why the wait ended with no input installed; undefined while it waits or once it has one. */
  get endedWithoutInput(): Error | undefined {
    return this.installed ? undefined : this.endReason
  }

  /** Aborts when the wait ends, so a Setup wait stops with it. */
  get endedSignal(): AbortSignal {
    return this.ending.signal
  }

  /** The admitted launch's own replay horizon, absolute: no read, edit or retry moves it. */
  arm(expiresAt: number): void {
    if (this.expiresAt !== undefined) {
      return
    }
    // Kept even once an input is installed: the effect still checks the clock before it starts.
    this.expiresAt = expiresAt
    if (this.endReason || this.installed) {
      return
    }
    this.timer = setTimeout(() => this.expireIfDue(), Math.max(0, expiresAt - this.now()))
    this.timer.unref?.()
  }

  setupSucceeded(): void {
    if (this.currentPhase === 'preparing' && !this.endReason) {
      this.currentPhase = 'awaiting-release'
      this.phaseChanged.resolve()
    }
  }

  /** True once the wait ended with no input, reading the clock rather than trusting the timer. */
  waitEnded(): boolean {
    this.expireIfDue()
    return this.endedWithoutInput !== undefined
  }

  /** Throws why the wait ended before any input, reading the clock rather than trusting the timer. */
  assertWaiting(): void {
    this.expireIfDue()
    if (this.endReason && !this.installed) {
      throw this.endReason
    }
  }

  /** Hands the execution its one input; false when the wait already ended or another input won. */
  install(digest: string, input: AgentLaunchReleasedInput): boolean {
    if (this.installed) {
      return this.installed.digest === digest
    }
    if (this.expireIfDue() || this.endReason) {
      return false
    }
    this.installed = { digest, input }
    this.input.resolve(input)
    this.clearTimer()
    this.phaseChanged.resolve()
    return true
  }

  /** The execution's barrier before any effect: the input, then a fresh clock check. */
  async finalInput(): Promise<AgentLaunchReleasedInput> {
    const input = await this.input.promise
    if (this.expiresAt !== undefined && this.now() >= this.expiresAt) {
      const expired = new AgentLaunchInputExpiredError(this.agent)
      this.finish(expired)
      throw expired
    }
    this.currentPhase = 'released'
    this.finish()
    return input
  }

  /** The input the execution consumed; only read after finalInput. */
  releasedInput(): AgentLaunchReleasedInput {
    if (!this.installed) {
      throw new Error('agent_launch_release_input_missing')
    }
    return this.installed.input
  }

  /** The held message as the launch delivers it: its released text under prepare's delivery. */
  releasedPrompt(): AgentLaunchPrompt | undefined {
    const input = this.releasedInput()
    return this.prompt && input.firstMessage
      ? { text: releasedMessageText(input), delivery: this.prompt.delivery }
      : undefined
  }

  /** The host paths of the released message's images, which a terminal pastes before its text. */
  releasedImages(): string[] {
    return releasedMessageImages(this.releasedInput()).flatMap((path) => (path ? [path] : []))
  }

  /** The chat's opening message, complete with its files and skills, under the released selection;
   *  a held draft founds none. */
  releasedFirstMessage(): StructuredAgentSessionFirstMessage | undefined {
    const input = this.releasedInput()
    return this.prompt?.delivery === 'submit' && input.firstMessage
      ? { ...input.firstMessage, selection: agentSessionExecutionOptionsRecord(input.selection) }
      : undefined
  }

  /** The terminal alternative with the released choices, compiled once and only when needed. A
   *  choice that contradicts the user's own command refuses in the compiler's words. */
  terminalStartup(): AgentLaunchTerminalStartupParams | undefined {
    const input = this.releasedInput()
    const images = releasedMessageImages(input)
    if (images.includes(null)) {
      throw new AgentLaunchSurfaceUnavailableError(
        `${formatAgentTypeLabel(this.agent)} can't open as a chat here, and a terminal can't attach an image given by URL, so it was not started.`
      )
    }
    this.compiled ??= compileAgentLaunchTerminalAlternative({
      alternative: this.terminalAlternative,
      heldText: releasedMessageText(input),
      heldImages: images.length > 0,
      choices: releasedTerminalChoices(input),
      replaceModelSelection: input.optionsMode === 'replace-model-selection'
    })
    if (!this.compiled.ok) {
      throw new AgentLaunchSurfaceUnavailableError(
        `${formatAgentTypeLabel(this.agent)} can't open as a chat here, so it was not started. ${this.compiled.error}`
      )
    }
    return this.compiled.startup
  }

  /** Every exit of the launch: the wait, its timer, close listener and phase readers all end. */
  finish(reason: Error = new AgentLaunchClosedBeforeDispatchError()): void {
    if (this.ending.signal.aborted) {
      return
    }
    this.endReason = reason
    this.input.reject(reason)
    this.clearTimer()
    this.closed.removeEventListener('abort', this.onClosed)
    this.ending.abort(reason)
    this.phaseChanged.resolve()
  }

  /** Ends the wait when the horizon passed with no input; true once that happened. */
  private expireIfDue(): boolean {
    if (this.endReason instanceof AgentLaunchInputExpiredError) {
      return true
    }
    if (
      this.installed ||
      this.endReason ||
      this.expiresAt === undefined ||
      this.now() < this.expiresAt
    ) {
      return false
    }
    this.finish(new AgentLaunchInputExpiredError(this.agent))
    return true
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }
}
