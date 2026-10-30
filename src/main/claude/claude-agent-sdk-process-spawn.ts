import { PassThrough } from 'node:stream'
import { ownRetainedString } from '../../shared/own-retained-string'
import { createProviderSourceCompletion } from '../provider-process/provider-source-completion'
import type { PipedChildProcess, PipedProcessSpawner } from '@orca/process-host/process-spec'
import type { SpawnOptions as ClaudeAgentSdkSpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import { spawnProcess } from '@orca/process-host'
import {
  spawnManagedProviderProcess,
  type ManagedProviderProcess
} from '../provider-process/managed-provider-process'
import { claudeChildClosePolicy, claudeChildCloseProven } from './claude-child-exit-proof-ladder'

export type ClaudeCodeProcessSpawn = {
  /** SDK spawn hook; Orca retains process ownership. */
  spawn: (options: ClaudeAgentSdkSpawnOptions) => PipedChildProcess
  readonly child: PipedChildProcess | null
  readonly managed: ManagedProviderProcess | null
  /** Supervisor pid on POSIX; lease ownership also requires start time and spawn token. */
  readonly pid: number | undefined
  /** The spawn spec's verdict, so the close ladder never re-decides it. False until the SDK spawns. */
  readonly supervised: boolean
  readonly inputClosing: boolean
  readonly receivedInput: boolean
  finishInput: () => Promise<void>
  readonly inputDone: Promise<void>
}

function hasChildProperty(
  child: PipedChildProcess,
  key: PropertyKey
): key is keyof PipedChildProcess {
  return key in child
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

// Orca owns the child for PID-based exit proof and Windows .cmd quoting.
// POSIX supervisors stop Claude if Orca dies; Windows spawns Claude directly.
export function createClaudeCodeProcessSpawn(
  spawnImpl: PipedProcessSpawner = spawnProcess,
  platform: NodeJS.Platform = process.platform,
  launch?: { pathToClaudeCodeExecutable: string; prefixArgs?: readonly string[] }
): ClaudeCodeProcessSpawn {
  let managed: ManagedProviderProcess | null = null
  let source: ReturnType<typeof createProviderSourceCompletion> | undefined
  let receivedInput = false
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
          inheritedEnv: definedEnv(options.env),
          site: 'claude-stream-json-teardown',
          policy: (supervised) => claudeChildClosePolicy(supervised, platform),
          acceptClose: claudeChildCloseProven
        }
      )
      const stdout = new PassThrough()
      let tail: string[] = []
      source = createProviderSourceCompletion(managed.child.stdout, {
        data: (chunk) => {
          receivedInput ||= chunk.length > 0
          const newline = chunk.lastIndexOf('\n')
          if (newline === -1) {
            tail.push(chunk)
          } else {
            stdout.write(tail.join('') + chunk.slice(0, newline + 1))
            tail = [ownRetainedString(chunk.slice(newline + 1))]
          }
        },
        end: (natural) => {
          stdout.end(natural ? tail.join('') : undefined)
          tail = []
        },
        error: () => {
          stdout.end()
          tail = []
        }
      })
      // Keep the real handle for exit proof; SDK cleanup only owns its stdout facade.
      return new Proxy(managed.child, {
        get: (child, key) => {
          if (key === 'stdout') {
            return stdout
          }
          const value = hasChildProperty(child, key) ? child[key] : undefined
          return typeof value === 'function' ? value.bind(child) : value
        }
      })
    },
    get inputDone() {
      return source?.done ?? Promise.resolve()
    },
    get inputClosing() {
      return source?.ending ?? false
    },
    get receivedInput() {
      return receivedInput
    },
    finishInput: () => source?.finish() ?? Promise.resolve(),
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
