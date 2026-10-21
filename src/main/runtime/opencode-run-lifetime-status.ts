import { tokenizeCommandLine } from '../../shared/agent-command-line-entrypoint'
import { recognizeAgentProcess } from '../../shared/agent-process-recognition'
import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../shared/agent-status-types'
import { FOREGROUND_COMMAND_READS } from '../../shared/foreground-command-settle'
import { isOpenCodeRunCommand } from '../../shared/opencode-headless-command'
import { isShellProcess } from '../../shared/shell-process-detection'

const SIGINT_EXIT_CODE = 130
// Launchers that can still exec OpenCode after the first read (`npx`/`bunx opencode-ai run`).
const OPENCODE_LAUNCHERS = new Set(['node', 'bun', 'bunx', 'npx', 'npm', 'pnpm', 'pnpx', 'yarn'])

// Why these only: a shell means the command has not exec'd yet, and a launcher may still exec
// OpenCode; any other program (another agent, vim, a dev server) never becomes OpenCode.
function mayStillBecomeOpenCode(processName: string): boolean {
  if (recognizeAgentProcess(processName) !== null) {
    return false
  }
  const base = (processName.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.(exe|cmd)$/, '')
  return isShellProcess(processName) || OPENCODE_LAUNCHERS.has(base)
}

type OpenCodeAgent = 'opencode' | 'opencode2'

type Dependencies = {
  /** Local PTYs only: SSH and WSL foregrounds cannot be read on this host. */
  isObservablePty(ptyId: string): boolean
  /** The per-agent status switch the plugin install honours (#23667). */
  isStatusEnabled(agent: OpenCodeAgent): boolean
  readForegroundProcessName(ptyId: string): Promise<string | null>
  readForegroundCommandLine(ptyId: string, foregroundProcess: string): Promise<string | null>
  /** `yieldsToHookSince`: the store drops this write once a hook reported the pane since then. */
  publish(ptyId: string, payload: ParsedAgentStatusPayload, yieldsToHookSince: number): void
  now(): number
}

type CommandState = {
  generation: number
  startedAt: number
  timer: ReturnType<typeof setTimeout> | null
  armed: OpenCodeAgent | null
}

/**
 * Reports `opencode run` from its own process lifetime: Working once the pane's foreground
 * command is an OpenCode `run`, Done when that command finishes. OpenCode 2's `run` loads no
 * plugin, so nothing else can say which pane it runs in.
 */
export class OpenCodeRunLifetimeStatus {
  private readonly commands = new Map<string, CommandState>()
  private nextGeneration = 0

  constructor(private readonly deps: Dependencies) {}

  onCommandStarted(ptyId: string): void {
    // Why: a new command proves the armed one ended even though its 133;D never arrived.
    this.onCommandFinished(ptyId, null)
    if (
      !this.deps.isObservablePty(ptyId) ||
      (!this.deps.isStatusEnabled('opencode') && !this.deps.isStatusEnabled('opencode2'))
    ) {
      return
    }
    const state: CommandState = {
      generation: ++this.nextGeneration,
      startedAt: this.deps.now(),
      timer: null,
      armed: null
    }
    this.commands.set(ptyId, state)
    this.scheduleInspect(ptyId, state, FOREGROUND_COMMAND_READS.settleMs, 0)
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
    const state = this.commands.get(ptyId)
    if (state?.timer) {
      clearTimeout(state.timer)
    }
    this.commands.delete(ptyId)
  }

  private scheduleInspect(
    ptyId: string,
    state: CommandState,
    delayMs: number,
    retryIndex: number
  ): void {
    state.timer = setTimeout(() => {
      state.timer = null
      void this.inspect(ptyId, state, retryIndex)
    }, delayMs)
  }

  private isCurrent(ptyId: string, state: CommandState): boolean {
    return this.commands.get(ptyId)?.generation === state.generation
  }

  private async inspect(ptyId: string, state: CommandState, retryIndex: number): Promise<void> {
    try {
      const name = await this.deps.readForegroundProcessName(ptyId)
      const agent = recognizeAgentProcess(name)?.agent
      if (!name || !this.isCurrent(ptyId, state)) {
        return
      }
      if (agent !== 'opencode' && agent !== 'opencode2') {
        const retryDelay = FOREGROUND_COMMAND_READS.retryDelaysMs[retryIndex]
        if (retryDelay !== undefined && mayStillBecomeOpenCode(name)) {
          this.scheduleInspect(ptyId, state, retryDelay, retryIndex + 1)
        }
        return
      }
      if (!this.deps.isStatusEnabled(agent)) {
        return
      }
      const tokens = tokenizeCommandLine(
        (await this.deps.readForegroundCommandLine(ptyId, name)) ?? ''
      )
      if (
        !this.isCurrent(ptyId, state) ||
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
