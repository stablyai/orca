import { botMemoryKnown } from './bot-turn-memory-update'
import type { AgentSessionInstructionSnapshot } from '../native-chat/agent-session-wire/structured-agent-session-turn-context'
import type { BotHomeFiles } from './bot-preamble'
import type { AgentSessionInstructionBaseline } from '../../shared/agent-session/agent-session-instruction-policy'

type Baseline = {
  soul: string | null
  memory: string | null
  memoryText: string | null
  skills: string | null
  skillsNow: string | null
}

export function createBotInstructionDelivery(
  baseline: (sessionId: string) => Baseline | undefined,
  update: (sessionId: string, fields: Partial<Baseline>) => void,
  fingerprint: (text: string | null) => string
) {
  const candidates = new Map<
    string,
    { snapshot: AgentSessionInstructionSnapshot; prior: Partial<Baseline> }
  >()
  return {
    configure: (
      sessionId: string,
      snapshot: AgentSessionInstructionSnapshot,
      files: BotHomeFiles
    ) => {
      const given = baseline(sessionId)
      // Known file changes stay pending until an accepted turn carries them.
      const delivered = {
        soul: given?.soul ?? fingerprint(files.soul),
        memory: given?.memory ?? fingerprint(files.memory),
        memoryText:
          given && given.memory !== null ? given.memoryText : botMemoryKnown(null, files.memory),
        skills: given?.skillsNow ? fingerprint(given.skillsNow) : (given?.skills ?? null)
      }
      const proven = { soul: delivered.soul, memory: delivered.memory, skills: delivered.skills }
      candidates.set(sessionId, {
        snapshot: { ...snapshot, baseline: proven },
        prior: {
          soul: given?.soul ?? null,
          memory: given?.memory ?? null,
          memoryText: given?.memoryText ?? null,
          skills: given?.skills ?? null
        }
      })
      update(sessionId, delivered)
    },
    snapshot: (sessionId: string) => candidates.get(sessionId)?.snapshot ?? null,
    accepted: (
      sessionId: string,
      digest: string,
      filesIncluded: boolean,
      proven?: AgentSessionInstructionBaseline
    ) => {
      const candidate = candidates.get(sessionId)
      if (candidate?.snapshot.digest === digest) {
        candidates.delete(sessionId)
        if (!filesIncluded) {
          update(
            sessionId,
            proven
              ? {
                  ...proven,
                  memoryText:
                    candidate.prior.memory === proven.memory
                      ? (candidate.prior.memoryText ?? null)
                      : null
                }
              : candidate.prior
          )
        }
      }
    },
    forget: (sessionId: string) => {
      candidates.delete(sessionId)
    }
  }
}
