import type { ClaudeStreamJsonConnection } from './claude-stream-json-connection'
import type { ClaudeStructuredLaunch } from './claude-structured-launch-resolution'
import { claudeNamingLaunchInputs, type ClaudeNamingInputs } from './claude-naming-invocation'

type Phase = 'acquiring' | 'initializing' | 'ready' | 'closing' | 'exited' | 'unproven'
export type ClaudeNamingGeneration = {
  chat: string
  boundary: string | undefined
  nativeId: string
  inputs?: ClaudeNamingInputs
  connection?: ClaudeStreamJsonConnection
  phase: Phase
  closing?: Promise<boolean>
  subscribe(listener: () => void): () => void
  launch(launch: ClaudeStructuredLaunch): void
  attach(connection: ClaudeStreamJsonConnection): void
  initialized(): void
  failed(): void
}

/** Registered before acquisition can read or spawn; readiness and cleanup progress independently. */
export function createClaudeNamingGeneration(
  chat: string,
  boundary: string | undefined,
  nativeId: string,
  changed: () => void
) {
  const listeners = new Set<() => void>()
  const notify = () => {
    changed()
    for (const listener of listeners) {
      listener()
    }
  }
  const generation: ClaudeNamingGeneration = {
    chat,
    boundary,
    nativeId,
    inputs: undefined,
    connection: undefined,
    phase: 'acquiring',
    closing: undefined,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    launch(launch: ClaudeStructuredLaunch) {
      generation.nativeId = launch.providerSessionId
      generation.inputs = claudeNamingLaunchInputs(launch)
      notify()
    },
    attach(connection: ClaudeStreamJsonConnection) {
      generation.connection = connection
      if (generation.phase !== 'exited') {
        generation.phase = 'initializing'
      }
      const close = connection.close
      connection.close = () => {
        generation.phase = 'closing'
        const done = close.call(connection)
        generation.closing = done
        notify()
        return done.finally(() => {
          if (generation.closing === done) {
            generation.phase = connection.exitVerdict.root === 'exited' ? 'exited' : 'unproven'
            notify()
          }
        })
      }
      notify()
    },
    initialized() {
      if (generation.phase === 'initializing') {
        generation.phase = 'ready'
        notify()
      }
    },
    failed() {
      if (generation.phase !== 'closing') {
        generation.phase =
          !generation.connection || generation.connection.exitVerdict.root === 'exited'
            ? 'exited'
            : 'unproven'
        notify()
      }
    }
  }
  return generation
}
