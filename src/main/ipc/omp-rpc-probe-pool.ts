// Pool of session-LESS OMP RPC probes, one per workspace cwd. A probe reads the
// live slash-command catalog and runs allowlisted local commands (/usage). It is
// spawned with noSession:true so it can never contend with the pane's live TUI
// session for a session file — the pane keeps its PTY, the probe answers
// questions beside it.

import type {
  OmpRpcBaseSpawnOptions,
  OmpRpcClientEvent,
  OmpRpcClientLike,
  OmpRpcSlashCommand,
  OmpRpcSpawnOptions
} from '../../shared/omp-rpc-protocol'
import {
  isAllowedOmpRpcLocalCommand,
  type OmpRpcGetCommandsResult,
  type OmpRpcRunLocalCommandResult
} from '../../shared/omp-rpc-ipc-contract'

/** Defensive ceiling on collected command_output. /usage answers in kilobytes;
 *  anything near this is a runaway peer, not a real answer. */
const MAX_COMMAND_OUTPUT_BYTES = 2_000_000
/** Re-read the catalog after this long even without a push, so a probe that
 *  missed an available_commands_update cannot serve a stale list forever. */
const COMMANDS_TTL_MS = 5 * 60_000

export type OmpRpcProbeDependencies = {
  /** Resolves the local OMP launch command, or null when it is not on PATH. */
  resolveExecutablePath: () => Promise<Omit<OmpRpcBaseSpawnOptions, 'cwd'> | null>
  spawn: (options: OmpRpcSpawnOptions) => OmpRpcClientLike
  now?: () => number
}

export type OmpRpcProbePool = {
  getCommands: (cwd: string) => Promise<OmpRpcGetCommandsResult>
  runLocalCommand: (cwd: string, command: string) => Promise<OmpRpcRunLocalCommandResult>
  /** Settles once every pooled child has exited. */
  dispose: () => Promise<void>
}

type Probe = {
  client: OmpRpcClientLike
  unsubscribe: () => void
  ready: Promise<void>
  commands: OmpRpcSlashCommand[] | null
  commandsAt: number
  /** Serializes local-command runs on this probe: `command_output` frames
   *  carry no request id, so two overlapping runs would collect each other's
   *  output and both callers would get the wrong text. */
  localCommandChain: Promise<unknown>
  /** Set once the child exits; the next call spawns a replacement. */
  exited: boolean
}

export function createOmpRpcProbePool(deps: OmpRpcProbeDependencies): OmpRpcProbePool {
  const now = deps.now ?? Date.now
  const probes = new Map<string, Probe>()
  // Why: two panes in one workspace can ask at the same moment; without this the
  // pool spawns two children for the same key and leaks one.
  const starting = new Map<string, Promise<Probe | null>>()
  // Why: a `start` still pending at dispose time resolves afterwards with a
  // live child and nobody left to dispose it; the flag lets that resolution
  // retire the child instead of registering it.
  let disposed = false

  function retire(cwd: string, probe: Probe): void {
    probe.exited = true
    probe.unsubscribe()
    probe.client.dispose()
    if (probes.get(cwd) === probe) {
      probes.delete(cwd)
    }
  }

  async function start(cwd: string): Promise<Probe | null> {
    const launch = await deps.resolveExecutablePath()
    if (!launch) {
      return null
    }
    const client = deps.spawn({ ...launch, cwd, noSession: true })
    const probe: Probe = {
      client,
      unsubscribe: () => {},
      ready: Promise.resolve(),
      commands: null,
      commandsAt: 0,
      localCommandChain: Promise.resolve(),
      exited: false
    }
    probe.unsubscribe = client.on((event: OmpRpcClientEvent) => {
      if (event.kind === 'commands') {
        probe.commands = event.commands
        probe.commandsAt = now()
        return
      }
      if (event.kind === 'exit') {
        retire(cwd, probe)
      }
    })
    probe.ready = client.whenReady().then(() => undefined)
    return probe
  }

  async function acquire(cwd: string): Promise<Probe | null> {
    const existing = probes.get(cwd)
    if (existing && !existing.exited) {
      return existing
    }
    const inFlight = starting.get(cwd)
    if (inFlight) {
      return inFlight
    }
    const request = start(cwd)
      .then(async (probe) => {
        if (!probe) {
          return null
        }
        if (disposed) {
          retire(cwd, probe)
          // Retiring sends the termination signal, but shutdown ownership is
          // only complete after the child confirms exit.
          await probe.client.whenExited()
          return null
        }
        probes.set(cwd, probe)
        return probe
      })
      .finally(() => {
        if (starting.get(cwd) === request) {
          starting.delete(cwd)
        }
      })
    starting.set(cwd, request)
    return request
  }

  async function getCommands(cwd: string): Promise<OmpRpcGetCommandsResult> {
    let probe: Probe | null
    try {
      probe = await acquire(cwd)
    } catch {
      return { ok: false, errorCode: 'spawn-failed' }
    }
    if (!probe) {
      return { ok: false, errorCode: 'executable-not-found' }
    }
    try {
      await probe.ready
    } catch {
      retire(cwd, probe)
      return { ok: false, errorCode: 'not-ready' }
    }
    if (probe.commands && now() - probe.commandsAt < COMMANDS_TTL_MS) {
      return { ok: true, commands: probe.commands }
    }
    try {
      const commands = await probe.client.getCommands()
      probe.commands = commands
      probe.commandsAt = now()
      return { ok: true, commands }
    } catch {
      return { ok: false, errorCode: 'request-failed' }
    }
  }

  async function runLocalCommand(
    cwd: string,
    command: string
  ): Promise<OmpRpcRunLocalCommandResult> {
    // Why: the allowlist is checked in the MAIN process, before any spawn. A
    // compromised renderer must not be able to drive arbitrary prompts through
    // the probe just by naming a different command.
    if (!isAllowedOmpRpcLocalCommand(command)) {
      return { ok: false, errorCode: 'not-allowed' }
    }
    let probe: Probe | null
    try {
      probe = await acquire(cwd)
    } catch {
      return { ok: false, errorCode: 'spawn-failed' }
    }
    if (!probe) {
      return { ok: false, errorCode: 'executable-not-found' }
    }
    try {
      await probe.ready
    } catch {
      retire(cwd, probe)
      return { ok: false, errorCode: 'not-ready' }
    }
    const collector = createOutputCollector()
    const run = probe.localCommandChain.then(async () => {
      const stop = probe.client.on((event) => {
        if (event.kind === 'command-output') {
          collector.append(event.text)
        }
      })
      try {
        return await probe.client.prompt(command.trim())
      } finally {
        stop()
      }
    })
    probe.localCommandChain = run.then(
      () => undefined,
      () => undefined
    )
    try {
      const result = await run
      return {
        ok: true,
        outputText: collector.text(),
        agentInvoked: result.agentInvoked,
        ...(collector.truncated() ? { truncated: true as const } : {})
      }
    } catch {
      return { ok: false, errorCode: 'request-failed' }
    }
  }

  return {
    getCommands,
    runLocalCommand,
    dispose: () => {
      disposed = true
      // Why: tear down in place then clear, rather than retire() per entry —
      // retire deletes from the map, which would mutate what we are iterating.
      const exits: Promise<unknown>[] = []
      for (const probe of probes.values()) {
        probe.exited = true
        probe.unsubscribe()
        probe.client.dispose()
        exits.push(probe.client.whenExited())
      }
      probes.clear()
      // A resolver may still be about to spawn a child. `acquire` retires that
      // late probe and waits for its exit before its starting promise settles.
      const startingExits = [...starting.values()]
      return Promise.allSettled([...exits, ...startingExits]).then(() => undefined)
    }
  }
}

/** Collects command_output in arrival order, bounded by byte length. Ordering is
 *  the contract: OMP emits output as a stream of frames and the concatenation is
 *  the answer. */
function createOutputCollector(): {
  append: (text: string) => void
  text: () => string
  truncated: () => boolean
} {
  const parts: string[] = []
  let bytes = 0
  let truncated = false
  return {
    append: (text) => {
      if (truncated) {
        return
      }
      const size = Buffer.byteLength(text, 'utf8')
      if (bytes + size > MAX_COMMAND_OUTPUT_BYTES) {
        truncated = true
        return
      }
      bytes += size
      parts.push(text)
    },
    text: () => parts.join(''),
    truncated: () => truncated
  }
}
