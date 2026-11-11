import { withOrcaClaudeChatEntrypoint } from '../../shared/agent-launch/startup/claude-chat-entrypoint'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { PipedProcessSpawner } from '@orca/process-host/process-spec'
import type { SpawnOptions as ClaudeAgentSdkSpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import { spawnProcess } from '@orca/process-host'
import {
  spawnManagedProviderProcess,
  type ManagedProviderProcess
} from '../provider-process/managed-provider-process'
import { claudeChildClosePolicy, claudeChildCloseProven } from './claude-child-exit-proof-ladder'

export type ClaudeCodeProcessSpawn = {
  /** SDK spawn hook; Orca retains process ownership. */
  spawn: (options: ClaudeAgentSdkSpawnOptions) => ChildProcessWithoutNullStreams
  readonly child: ChildProcessWithoutNullStreams | null
  readonly managed: ManagedProviderProcess | null
  /** Supervisor pid on POSIX; lease ownership also requires start time and spawn token. */
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

/** Subscribes alongside the SDK's reader: an earlier listener would drain output it never sees. */
function observeStdoutWithReader(
  stdout: ChildProcessWithoutNullStreams['stdout'],
  onStdout: (chunk: Buffer | string) => void
): void {
  const onSubscribe = (event: string | symbol): void => {
    if (event !== 'data' && event !== 'readable') {
      return
    }
    stdout.removeListener('newListener', onSubscribe)
    // Same tick as the reader, so no chunk can be emitted to one and not the other.
    stdout.on('data', onStdout)
  }
  stdout.on('newListener', onSubscribe)
}

// Orca owns the child for PID-based exit proof and Windows .cmd quoting.
// POSIX supervisors stop Claude if Orca dies; Windows spawns Claude directly.
export function createClaudeCodeProcessSpawn(
  spawnImpl: PipedProcessSpawner = spawnProcess,
  platform: NodeJS.Platform = process.platform,
  launch?: { pathToClaudeCodeExecutable: string; prefixArgs?: readonly string[] },
  onStdout?: (chunk: Buffer | string) => void
): ClaudeCodeProcessSpawn {
  let managed: ManagedProviderProcess | null = null
  return {
    spawn: (options) => {
      const args = [...options.args]
      // The SDK runs script programs through a runtime, keeping the script at argv[0].
      const script = launch && /\.(?:js|mjs|ts|tsx|jsx)$/.test(launch.pathToClaudeCodeExecutable)
      args.splice(script ? 1 : 0, 0, ...(launch?.prefixArgs ?? []))
      // SDK abort would kill the child outside Orca's ladder, losing observed exit proof.
      managed = spawnManagedProviderProcess(
        {
          command: options.command,
          args,
          ...(options.cwd === undefined ? {} : { cwd: options.cwd })
        },
        {
          spawnImpl,
          platform,
          inheritedEnv: withOrcaClaudeChatEntrypoint(definedEnv(options.env), platform),
          site: 'claude-stream-json-teardown',
          policy: (supervised) => claudeChildClosePolicy(supervised, platform),
          acceptClose: claudeChildCloseProven
        }
      )
      if (onStdout) {
        observeStdoutWithReader(managed.child.stdout, onStdout)
      }
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
