import type { PipedChildProcess, PipedProcessSpawner } from '@orca/process-host/process-spec'
import type { SpawnOptions as ClaudeAgentSdkSpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import { spawnProcess } from '@orca/process-host'
import {
  spawnManagedProviderProcess,
  type ManagedProviderProcess
} from '../provider-process/managed-provider-process'
import { claudeChildClosePolicy, claudeChildCloseProven } from './claude-child-exit-proof-ladder'

export type ClaudeCodeProcessSpawn = {
  /** Pass as the SDK's `spawnClaudeCodeProcess`; the SDK never learns the pid because it never owns it. */
  spawn: (options: ClaudeAgentSdkSpawnOptions) => PipedChildProcess
  /** The retained child, so Orca keeps its own tree-kill and exit-proof ladder. Null until the SDK spawns. */
  readonly child: PipedChildProcess | null
  readonly managed: ManagedProviderProcess | null
  /**
   * Ownership proof: the durable lease adjudicates on this pid plus start time plus the spawn
   * token. On POSIX it is the provider supervisor's, which outlives Claude by construction.
   */
  readonly pid: number | undefined
  /** The spawn spec's verdict, so the close ladder never re-decides it. False until the SDK spawns. */
  readonly supervised: boolean
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
  spawnImpl: PipedProcessSpawner = spawnProcess,
  platform: NodeJS.Platform = process.platform,
  onOutput?: () => void
): ClaudeCodeProcessSpawn {
  let managed: ManagedProviderProcess | null = null
  return {
    spawn: (options) => {
      // SDK abort would kill the child outside Orca's ladder, losing observed exit proof.
      managed = spawnManagedProviderProcess(
        {
          command: options.command,
          args: [...options.args],
          ...(options.cwd === undefined ? {} : { cwd: options.cwd })
        },
        {
          spawnImpl,
          platform,
          inheritedEnv: definedEnv(options.env),
          site: 'claude-stream-json-teardown',
          policy: (supervised) => claudeChildClosePolicy(supervised, platform),
          acceptClose: claudeChildCloseProven,
          ...(onOutput ? { onOutput } : {})
        }
      )
      // The SDK drains stderr only for its own local spawn; the managed process drains it here.
      return managed.child
    },
    get child() {
      return managed?.child ?? null
    },
    get managed() {
      return managed
    },
    get pid() {
      return managed?.child.pid
    },
    get supervised() {
      return managed?.supervised ?? false
    }
  }
}
