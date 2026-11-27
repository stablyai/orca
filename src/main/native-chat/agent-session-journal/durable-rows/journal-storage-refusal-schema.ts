import { z } from 'zod'
import { lazyZodSchema } from '../../../../shared/schema/lazy-zod-schema'
import { AgentJournalKnownSchemas } from '../../../../shared/agent-session/journal/agent-session-journal-schemas'

// A saved refusal, as a failure fact or a bot run card keeps it: its code and the details readers word.

const text = lazyZodSchema(() => z.string().optional())
const count = lazyZodSchema(() => z.number().optional())
const argumentProblem = lazyZodSchema(() =>
  z.object({ agent: z.string(), option: z.string(), problem: z.string() })
)

const refusalDetails = lazyZodSchema(() =>
  z.object({
    reason: text,
    ownerVerdict: text,
    rewindReason: text,
    account: text,
    argumentProblem: argumentProblem.optional(),
    agent: text,
    agentInstallation: z
      .object({ agent: z.string(), installedVersion: z.string(), minimumVersion: z.string() })
      .optional(),
    codexInstallation: z
      .object({ installedVersion: z.string().nullable(), minimumVersion: z.string() })
      .optional(),
    expiredAttachments: z.array(z.object({ uploadId: z.string(), name: z.string() })).optional(),
    otherFolder: z.literal(true).optional(),
    currentFence: count,
    currentRevision: count,
    resolution: AgentJournalKnownSchemas.resolution.optional(),
    owner: z.object({ sessionId: z.string(), workspaceId: z.string() }).optional()
  })
)

export const storedRefusalReference = lazyZodSchema(() =>
  z.object({
    code: z.string().min(1),
    details: refusalDetails.optional()
  })
)
