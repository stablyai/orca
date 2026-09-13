import type { SpawnOptions as ClaudeAgentSdkSpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import { spawnProcess } from '../../shared/child-process/run-process'

/** Derived rather than imported: only src/shared/child-process may name node:child_process. */
type ClaudeCodeChild = ReturnType<typeof spawnProcess>

const STDERR_TAIL_MAX_BYTES = 8192

export type ClaudeCodeProcessSpawn = {
  /** Pass as the SDK's `spawnClaudeCodeProcess`; the SDK never learns the pid because it never owns it. */
  spawn: (options: ClaudeAgentSdkSpawnOptions) => ClaudeCodeChild
  /** The retained child, so Orca keeps its own tree-kill and exit-proof ladder. Null until the SDK spawns. */
  readonly child: ClaudeCodeChild | null
  /** Ownership proof: the durable lease adjudicates on this pid plus start time plus the spawn token. */
  readonly pid: number | undefined
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
 */
export function createClaudeCodeProcessSpawn(
  spawnImpl: typeof spawnProcess = spawnProcess
): ClaudeCodeProcessSpawn {
  let child: ClaudeCodeChild | null = null
  let stderrTail = ''
  return {
    spawn: (options) => {
      // Why `options.signal` is dropped: it would let the SDK kill the child outside
      // Orca's ladder, and close() may never report an exit it did not observe.
      const spawned = spawnImpl({
        program: options.command,
        args: [...options.args],
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        env: definedEnv(options.env),
        stdio: ['pipe', 'pipe', 'pipe']
      })
      child = spawned
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
    get stderrTail() {
      return stderrTail
    }
  }
}
