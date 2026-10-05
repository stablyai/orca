import type { SpawnOptions as ClaudeAgentSdkSpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import { spawnProcess } from '../../shared/child-process/run-process'
import { createProviderSpawnSpec } from '../codex/codex-app-server-posix-supervisor'

/** Derived rather than imported: only src/shared/child-process may name node:child_process. */
type ClaudeCodeChild = ReturnType<typeof spawnProcess>

const STDERR_TAIL_MAX_BYTES = 8192

export type ClaudeCodeProcessSpawn = {
  /** Pass as the SDK's `spawnClaudeCodeProcess`; the SDK never learns the pid because it never owns it. */
  spawn: (options: ClaudeAgentSdkSpawnOptions) => ClaudeCodeChild
  /** The retained child, so Orca keeps its own tree-kill and exit-proof ladder. Null until the SDK spawns. */
  readonly child: ClaudeCodeChild | null
  /**
   * Ownership proof: the durable lease adjudicates on this pid plus start time plus the spawn
   * token. On POSIX it is the provider supervisor's, which outlives Claude by construction.
   */
  readonly pid: number | undefined
  /** The spawn spec's verdict, so the close ladder never re-decides it. False until the SDK spawns. */
  readonly supervised: boolean
  readonly stderrTail: string
}

function definedEnv(env: Record<string, string | undefined>): Record<string, string> {
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      next[key] = value
    }
  }
  return next
}

/**
 * Orca supplies the Claude Code child rather than letting the SDK spawn it.
 *
 * Two independent reasons: the SDK's `SpawnedProcess` has no pid, and Orca's
 * spawner is the only path that encodes `.cmd` arguments safely on Windows.
 *
 * On POSIX Claude runs under the provider supervisor, so an Orca that dies stops
 * it instead of leaving it to finish its turn, tools and edits included, with
 * nobody watching. Windows has no supervisor and spawns Claude directly.
 */
export function createClaudeCodeProcessSpawn(
  spawnImpl: typeof spawnProcess = spawnProcess,
  platform: NodeJS.Platform = process.platform
): ClaudeCodeProcessSpawn {
  let child: ClaudeCodeChild | null = null
  let stderrTail = ''
  let supervised = false
  return {
    spawn: (options) => {
      const spec = createProviderSpawnSpec(
        {
          command: options.command,
          args: [...options.args],
          ...(options.cwd === undefined ? {} : { cwd: options.cwd })
        },
        definedEnv(options.env),
        platform
      )
      // Why `options.signal` is dropped: it would let the SDK kill the child outside
      // Orca's ladder, and close() may never report an exit it did not observe.
      const spawned = spawnImpl({
        program: spec.program,
        args: spec.args,
        cwd: spec.cwd,
        env: spec.env,
        detached: spec.detached,
        stdio: ['pipe', 'pipe', 'pipe']
      })
      child = spawned
      supervised = spec.supervised
      // The SDK drains stderr only for its own local spawn, so a custom spawner must:
      // otherwise the child blocks on a full pipe and exit errors lose their tail.
      spawned.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_MAX_BYTES)
      })
      return spawned
    },
    get child() {
      return child
    },
    get pid() {
      return child?.pid
    },
    get supervised() {
      return supervised
    },
    get stderrTail() {
      return stderrTail
    }
  }
}
