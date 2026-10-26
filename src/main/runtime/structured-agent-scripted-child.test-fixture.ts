// Drive each registered real adapter/host/store/journal with a scripted child behind its transport seam; registrations without fixtures fail the matrix.

import type { StructuredAgentSessionRuntimeDeps } from './structured-agent-session-runtime'

export type ScriptedAgentChild = {
  /** Override every launch/transport path to the scripted child; reaching any real binary is a fixture bug. */
  readonly deps: Partial<StructuredAgentSessionRuntimeDeps>
  /** Hold each new protocol handshake until released (default true); false answers immediately. */
  holdHandshakes: boolean
  /** Answers the held handshake of the newest spawn. */
  releaseHandshake(): void
  /** Fails the held handshake of the newest spawn with this provider error; its process exits. */
  failHandshake(message: string): void
  /** Default prompts complete immediately; false keeps turns running until interrupt or child exit, modeling background work. */
  completeTurns: boolean
  /** The text of every prompt any spawn received, in order. */
  prompts(): readonly string[]
  /** How many children were spawned. */
  spawns(): number
  /** How many spawns reopened the conversation the previous child left (resume / load). */
  resumes(): number
  /** How many children ended because Orca closed them. */
  closes(): number
}

export type ScriptedAgentChildFactory = () => ScriptedAgentChild
