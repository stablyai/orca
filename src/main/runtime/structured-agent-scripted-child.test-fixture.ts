// What the registration matrix drives each agent's real adapter through: a scripted provider child
// behind the adapter's own transport seam, so the adapter, host, store and journal are the shipped
// ones and no process is ever spawned. Each agent's fixture implements this; the matrix fails for a
// registration with none.

import type { StructuredAgentSessionRuntimeDeps } from './structured-agent-session-runtime'

export type ScriptedAgentChild = {
  /** Runtime overrides that route this agent's adapter to the script, launch resolution included:
   *  a fixture that lets any path reach a real binary is a bug. */
  readonly deps: Partial<StructuredAgentSessionRuntimeDeps>
  /** Each spawn's handshake holds until released: the protocol session it opens (a thread, an ACP
   *  session, Pi's session file, Claude's initialize answer) is not answered before. True by
   *  default; while false, a spawn's handshake answers at once. */
  holdHandshakes: boolean
  /** Answers the held handshake of the newest spawn. */
  releaseHandshake(): void
  /** Fails the held handshake of the newest spawn with this provider error; its process exits. */
  failHandshake(message: string): void
  /** False: a prompt opens a turn that runs until it is interrupted or its child ends, as a turn
   *  with background work does. True by default: each prompt's turn completes at once. */
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
