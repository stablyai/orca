import {
  createSetupWaitGate,
  SETUP_WAIT_GATE_MAX_MS
} from '../../../../shared/agent-launch/startup/setup-wait-output-gate'
import { waitForPromiseWithSignal } from '../../../../shared/concurrency/abort-signal-reason'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { RuntimeTerminalCreate } from '../../../../shared/terminal/runtime/runtime-terminal-create-contract'
import { SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV } from '../../../../shared/agent-launch/startup/setup-agent-sequencing'
import type { TerminalCreateOptions } from '../../terminal/launch/terminal-create-options'
import type {
  WorktreeStartupDraftPaste,
  WorktreeStartupFollowup
} from './runtime-worktree-agent-startup'
import type {
  StartupFollowupPromptOptions,
  WorktreeStartupReadinessHost
} from './runtime-worktree-startup-readiness'

export function generatedSetupStartupCommand(
  opts: TerminalCreateOptions,
  connectionId: string | null | undefined
): string | undefined {
  return !connectionId && opts.launchConfig?.commandProvenance === 'generated'
    ? opts.env?.[SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]
    : undefined
}

type WorktreeSetupOutcome = 'started' | 'blocked' | 'failed'

function waitForWorktreeSetupGate(
  host: WorktreeStartupReadinessHost,
  ptyId: string,
  signal: AbortSignal
): Promise<WorktreeSetupOutcome> {
  if (signal.aborted) {
    return Promise.resolve('failed')
  }
  return new Promise((resolve) => {
    const gate = createSetupWaitGate(true)
    let unsubscribe: (() => void) | undefined
    const finish = (outcome: WorktreeSetupOutcome): void => {
      clearTimeout(timer)
      unsubscribe?.()
      signal.removeEventListener('abort', abort)
      resolve(outcome)
    }
    const abort = (): void => finish('failed')
    const timer = setTimeout(abort, SETUP_WAIT_GATE_MAX_MS)
    const observe = (data: string): void => {
      const { phase, blocked } = gate.observe(data)
      if (phase === 'started' || phase === 'failed') {
        finish(blocked ? 'blocked' : phase)
      }
    }
    signal.addEventListener('abort', abort, { once: true })
    unsubscribe = host.subscribeToData(ptyId, observe)
    observe(host.readRecentOutput(ptyId) ?? '')
  })
}

type WorktreeSetupStartup = {
  startup: TerminalCreateOptions
  gate: Promise<WorktreeSetupOutcome>
  replay: (terminal: RuntimeTerminalCreate, entry: WorktreeSetupStartup) => void
  draft?: WorktreeStartupDraftPaste
  followup?: WorktreeStartupFollowup
  clear: () => void
  blocked?: boolean
  retry?: Promise<RuntimeTerminalCreate>
}

export class WorktreeSetupStartupRequests {
  private readonly entries = new Map<string, WorktreeSetupStartup>()
  private readonly handles = new Map<string, WorktreeSetupStartup>()

  observe(args: {
    worktreeId: string
    handle: string
    startup: TerminalCreateOptions
    host: WorktreeStartupReadinessHost
    ptyId: string
    signal: AbortSignal
    started: () => void
    replay: WorktreeSetupStartup['replay']
  }): void {
    const { worktreeId, handle, startup, host, ptyId, signal, started, replay } = args
    const clear = (): void => {
      signal.removeEventListener('abort', clear)
      if (this.entries.get(worktreeId) === entry) {
        this.entries.delete(worktreeId)
      }
      this.handles.delete(handle)
    }
    const gate = waitForWorktreeSetupGate(host, ptyId, signal)
    const entry: WorktreeSetupStartup = { startup, gate, clear, replay }
    this.entries.get(worktreeId)?.clear()
    this.entries.set(worktreeId, entry)
    this.handles.set(handle, entry)
    signal.addEventListener('abort', clear, { once: true })
    void gate.then((outcome) => {
      if (outcome === 'started' && !signal.aborted) {
        started()
      }
      if (outcome === 'blocked' && !signal.aborted) {
        entry.blocked = true
      } else {
        clear()
      }
    })
  }

  forHandle(handle: string): WorktreeSetupStartup | undefined {
    return this.handles.get(handle)
  }

  async retry(
    worktreeId: string,
    agent: TuiAgent,
    create: (startup: TerminalCreateOptions) => Promise<RuntimeTerminalCreate>
  ): Promise<RuntimeTerminalCreate | null> {
    const entry = this.entries.get(worktreeId)
    if (!entry?.blocked || entry.startup.launchAgent !== agent) {
      return null
    }
    entry.retry ??= create({ ...entry.startup, refreshAgentProgram: true })
      .then((terminal) => {
        if (!terminal.agentProgramBlocked && !terminal.agentResumeRefused && !terminal.isReattach) {
          entry.clear()
          entry.replay(terminal, entry)
        }
        return terminal
      })
      .finally(() => {
        delete entry.retry
      })
    return entry.retry
  }

  async deliverFollowup(
    host: WorktreeStartupReadinessHost,
    handle: string,
    options: StartupFollowupPromptOptions | undefined,
    lifecycleSignal: (ptyId: string) => AbortSignal,
    deliver: (afterSetup?: StartupFollowupPromptOptions) => Promise<boolean>
  ): Promise<boolean> {
    const setup = this.forHandle(handle)
    if (!options?.awaitSetupGate && !setup) {
      return deliver(options)
    }
    const ptyId = host.getPtyId(handle)
    if (!ptyId) {
      return false
    }
    const lifecycle = lifecycleSignal(ptyId)
    const signal = options?.signal ? AbortSignal.any([lifecycle, options.signal]) : lifecycle
    const outcome = await (setup
      ? waitForPromiseWithSignal(setup.gate, signal).catch(() => 'failed')
      : waitForWorktreeSetupGate(host, ptyId, signal))
    return outcome === 'started' && !signal.aborted && deliver({ ...options, signal })
  }
}
