import type { AgentSessionOwnerProbe } from '../../shared/agent-session-lease-adjudication'
import type { AgentSessionProcessIdentity } from '../../shared/agent-session-record'
import { probeAgentSessionProcessIdentity } from './agent-session-process-identity-probe'

const STOP_ATTEMPTS = 50
const STOP_POLL_MS = 100

function provesAbsence(proof: AgentSessionOwnerProbe): boolean {
  return proof.outcome === 'pid-absent' || proof.outcome === 'identity-mismatch'
}

function provesIdentity(proof: AgentSessionOwnerProbe): boolean {
  return proof.outcome === 'identity-matched' && proof.matchedOn.length > 0
}

export async function stopAdoptedCodexTui(input: {
  identity: AgentSessionProcessIdentity
  probe?: (identity: AgentSessionProcessIdentity) => Promise<AgentSessionOwnerProbe>
  signal?: (pid: number, signal: NodeJS.Signals) => void
  sleep?: (delayMs: number) => Promise<void>
  attempts?: number
  pollMs?: number
}): Promise<void> {
  const probe = input.probe ?? ((identity) => probeAgentSessionProcessIdentity({ identity }))
  const signal = input.signal ?? process.kill
  const initial = await probe(input.identity)
  if (provesAbsence(initial)) {
    return
  }
  if (!provesIdentity(initial)) {
    throw new Error(
      'The Codex TUI process could not be re-proved; structured chat was not started.'
    )
  }

  try {
    signal(input.identity.pid, 'SIGTERM')
  } catch (error) {
    if (provesAbsence(await probe(input.identity))) {
      return
    }
    throw error
  }

  const attempts = input.attempts ?? STOP_ATTEMPTS
  const sleep = input.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)))
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const proof = await probe(input.identity)
    if (provesAbsence(proof)) {
      return
    }
    if (attempt === 2 && provesIdentity(proof)) {
      signal(input.identity.pid, 'SIGKILL')
    }
    if (attempt + 1 < attempts) {
      await sleep(input.pollMs ?? STOP_POLL_MS)
    }
  }
  throw new Error('The Codex TUI exit could not be proven; structured chat was not started.')
}
