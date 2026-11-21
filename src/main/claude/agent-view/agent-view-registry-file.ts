import { readFileSync, rmSync } from 'node:fs'
import { z } from 'zod'
import { writeFileAtomically } from '../../filesystem/atomic-file-publication'
import { parsePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import {
  CLAUDE_AGENT_VIEW_SHORTCUTS,
  ClaudeAgentViewObservation
} from '../../../shared/agent-hook-listener/providers/claude/view/claude-agent-view'

export const MAX_CLAUDE_AGENT_VIEW_SESSIONS = 1024

export const ClaudeAgentViewIdentity = z.object({
  paneKey: z
    .string()
    .max(256)
    .refine((value) => parsePaneKey(value) !== null),
  sessionId: z.string().min(1).max(256),
  instanceId: z.string().min(1).max(256)
})

const RegisteredView = ClaudeAgentViewIdentity.extend({
  chord: z.string().refine((chord) => CLAUDE_AGENT_VIEW_SHORTCUTS.some((s) => s.chord === chord)),
  seenAt: z.number(),
  view: ClaudeAgentViewObservation.optional()
})
export type RegisteredClaudeAgentView = z.infer<typeof RegisteredView>

const RegistryFile = z.object({
  version: z.literal(1),
  sessions: z.array(RegisteredView).max(MAX_CLAUDE_AGENT_VIEW_SESSIONS)
})

export function readClaudeAgentViewRegistry(filePath: string): RegisteredClaudeAgentView[] {
  try {
    const parsed = RegistryFile.safeParse(JSON.parse(readFileSync(filePath, 'utf8')))
    return parsed.success ? parsed.data.sessions : []
  } catch {
    return []
  }
}

export function writeClaudeAgentViewRegistry(
  filePath: string,
  sessions: readonly RegisteredClaudeAgentView[]
): void {
  if (sessions.length === 0) {
    rmSync(filePath, { force: true })
    return
  }
  writeFileAtomically(filePath, JSON.stringify({ version: 1, sessions }))
}
