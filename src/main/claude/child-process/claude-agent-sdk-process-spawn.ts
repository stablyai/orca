import { withOrcaClaudeChatEntrypoint } from '../../../shared/agent-launch/startup/claude-chat-entrypoint'
import { awaitProviderChildSpawn, type ProviderChild } from '../../provider-process/provider-child'
import type { ProviderProcessSpawner } from '../../provider-process/provider-process-spawn'
import type { SpawnOptions as ClaudeAgentSdkSpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import { spawnProcess } from '@orca/process-host'
import {
  spawnManagedProviderProcess,
  type ManagedProviderProcess
} from '../../provider-process/managed-provider-process'
import { claudeChildClosePolicy, claudeChildCloseProven } from './claude-child-exit-proof-ladder'
import {
  launchRelayedProviderProcess,
  providerRelayRouteInstalled
} from '../../provider-relay/app-provider-relays'
import { CLAUDE_RELAY_WORK_MARKERS } from '../relay/claude-relay-markers'
import { ClaudeRelaySpawnStandIn } from '../relay/claude-relay-spawn-stand-in'

export type ClaudeCodeProcessSpawn = {
  /** SDK spawn hook; Orca retains process ownership. */
  spawn: (options: ClaudeAgentSdkSpawnOptions) => ProviderChild
  readonly spawned: Promise<void>
  readonly child: ProviderChild | null
  readonly managed: ManagedProviderProcess | null
  /** Provider pid on POSIX; lease ownership also requires start time and spawn token. */
  readonly pid: number | undefined
  /** The spawn spec's verdict, so the close ladder never re-decides it. False until the SDK spawns. */
  readonly supervised: boolean
  /** Settles once `managed` exists; at once unless the launch goes through the terminal daemon. */
  readonly bound: Promise<void>
  /** The terminal daemon owns the agent (and reaps its group). */
  readonly relayed: boolean
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
  stdout: ProviderChild['stdout'],
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
// POSIX owner watchers stop Claude if Orca dies; Windows spawns Claude directly.
export function createClaudeCodeProcessSpawn(
  spawnImpl: ProviderProcessSpawner = spawnProcess,
  platform: NodeJS.Platform = process.platform,
  launch?: { pathToClaudeCodeExecutable: string; prefixArgs?: readonly string[] },
  onStdout?: (chunk: Buffer | string) => void,
  /** The chat whose agent should run under the terminal daemon, so it outlives a restart. */
  relayChatKey?: string
): ClaudeCodeProcessSpawn {
  let managed: ManagedProviderProcess | null = null
  let relayed = false
  let bound: Promise<void> = Promise.resolve()
  return {
    spawn: (options) => {
      const args = [...options.args]
      // The SDK runs script programs through a runtime, keeping the script at argv[0].
      const script = launch && /\.(?:js|mjs|ts|tsx|jsx)$/.test(launch.pathToClaudeCodeExecutable)
      args.splice(script ? 1 : 0, 0, ...(launch?.prefixArgs ?? []))
      const processLaunch = {
        command: options.command,
        args,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd })
      }
      const inheritedEnv = withOrcaClaudeChatEntrypoint(definedEnv(options.env), platform)
      // SDK abort would kill the child outside Orca's ladder, losing observed exit proof.
      const direct = (): ManagedProviderProcess =>
        spawnManagedProviderProcess(processLaunch, {
          spawnImpl,
          platform,
          inheritedEnv,
          site: 'claude-stream-json-teardown',
          policy: (supervised) => claudeChildClosePolicy(supervised, platform),
          acceptClose: claudeChildCloseProven
        })
      if (relayChatKey === undefined || !providerRelayRouteInstalled()) {
        managed = direct()
        if (onStdout) {
          observeStdoutWithReader(managed.child.stdout, onStdout)
        }
        // The SDK drains stderr only for its own local spawn; the managed process drains it here.
        return managed.child
      }
      // The SDK spawns synchronously; the daemon answers later, so its input waits in the stand-in.
      const standIn = new ClaudeRelaySpawnStandIn()
      if (onStdout) {
        observeStdoutWithReader(standIn.stdout, onStdout)
      }
      bound = (async () => {
        const kept = await launchRelayedProviderProcess(processLaunch, {
          chatKey: relayChatKey,
          markers: CLAUDE_RELAY_WORK_MARKERS,
          inheritedEnv,
          spawnOnly: true
        })
        relayed = kept !== null
        managed = kept?.managed ?? direct()
        standIn.bind(managed.child)
      })().catch((error: unknown) => {
        const failure = error instanceof Error ? error : new Error(String(error))
        standIn.fail(failure)
        throw failure
      })
      return standIn
    },
    get spawned() {
      return bound.then(
        () => (managed ? awaitProviderChildSpawn(managed.child) : undefined),
        () => {}
      )
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
    },
    get bound() {
      return bound
    },
    get relayed() {
      return relayed
    }
  }
}
