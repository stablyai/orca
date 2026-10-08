import { tokenizeCommandLine } from '../../shared/agent-command-line-entrypoint'
import { recognizeAgentProcess } from '../../shared/agent-process-recognition'
import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../shared/agent-status-types'
import { isOpenCodeRunCommand } from '../../shared/opencode-headless-command'

const SIGINT_EXIT_CODE = 130

type OpenCodeAgent = 'opencode' | 'opencode2'

type Dependencies = {
  /** The per-agent status switch the plugin install honours (#23667). */
  isStatusEnabled(agent: OpenCodeAgent): boolean
  readForegroundCommandLine(ptyId: string, foregroundProcess: string): Promise<string | null>
  /** `yieldsToHookSince`: the store drops this write once a hook reported the pane since then. */
  publish(ptyId: string, payload: ParsedAgentStatusPayload, yieldsToHookSince: number): void
  now(): number
}

type CommandState = {
  /** The command foreground tracker's id for this command; its samples carry it. */
  commandId: number
  startedAt: number
  armed: OpenCodeAgent | null
  inspecting: boolean
}

/**
 * Reports `opencode run` from its own process lifetime: Working once the pane's foreground
 * command is an OpenCode `run`, Done when that command finishes. OpenCode 2's `run` loads no
 * plugin, so nothing else can say which pane it runs in. It reads no foreground itself: it
 * consumes the command foreground tracker's samples.
 */
export class OpenCodeRunLifetimeStatus {
  private readonly commands = new Map<string, CommandState>()

  constructor(private readonly deps: Dependencies) {}

  /** Whether a command needs the tracker's start reads on this pane's behalf. */
  wantsStartReads(): boolean {
    return this.deps.isStatusEnabled('opencode') || this.deps.isStatusEnabled('opencode2')
  }

  onCommandStarted(ptyId: string, commandId: number): void {
    // Why: a new command proves the armed one ended even though its 133;D never arrived.
    this.onCommandFinished(ptyId, null)
    this.commands.set(ptyId, {
      commandId,
      startedAt: this.deps.now(),
      armed: null,
      inspecting: false
    })
  }

  onCommandFinished(ptyId: string, exitCode: number | null): void {
    const state = this.commands.get(ptyId)
    this.forgetPty(ptyId)
    if (!state?.armed) {
      return
    }
    const payload = normalizeAgentStatusPayload({
      state: 'done',
      prompt: '',
      agentType: state.armed,
      ...(exitCode === SIGINT_EXIT_CODE ? { interrupted: true } : {})
    })
    if (payload) {
      this.deps.publish(ptyId, payload, state.startedAt)
    }
  }

  forgetPty(ptyId: string): void {
    this.commands.delete(ptyId)
  }

  /** A foreground the tracker read during this pane's command. */
  observeForeground(ptyId: string, processName: string, commandId: number): void {
    const state = this.commands.get(ptyId)
    const agent = recognizeAgentProcess(processName)?.agent
    if (
      state?.commandId !== commandId ||
      state.armed ||
      state.inspecting ||
      (agent !== 'opencode' && agent !== 'opencode2') ||
      !this.deps.isStatusEnabled(agent)
    ) {
      return
    }
    state.inspecting = true
    void this.arm(ptyId, state, agent, processName).finally(() => {
      state.inspecting = false
    })
  }

  private async arm(
    ptyId: string,
    state: CommandState,
    agent: OpenCodeAgent,
    processName: string
  ): Promise<void> {
    try {
      const tokens = tokenizeCommandLine(
        (await this.deps.readForegroundCommandLine(ptyId, processName)) ?? ''
      )
      if (
        this.commands.get(ptyId) !== state ||
        recognizeAgentProcess(tokens[0])?.agent !== agent ||
        !isOpenCodeRunCommand(tokens)
      ) {
        return
      }
      const payload = normalizeAgentStatusPayload({
        state: 'working',
        prompt: '',
        agentType: agent
      })
      if (!payload) {
        return
      }
      state.armed = agent
      this.deps.publish(ptyId, payload, state.startedAt)
    } catch {
      // Why: a failed read is missing evidence; the pane stays silent rather than guessed.
    }
  }
}
