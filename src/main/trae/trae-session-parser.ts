import type { FileWithMtime } from '../ai-vault/session-scanner-types'
import type { TranscriptMessageSink } from '../ai-vault/transcripts/session-transcript-consumers'
import { parseCodexSessionFile } from '../ai-vault/scanners/codex/session-scanner-codex-parser'
import { buildAiVaultResumeCommand } from '../../shared/ai-vault/resume/ai-vault-resume-command'
import { resolveTraeCliHome } from './trae-cli-home'

export async function parseTraeSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform,
  messages?: TranscriptMessageSink
) {
  const home = resolveTraeCliHome()
  const session = await parseCodexSessionFile(file, platform, home, undefined, messages)
  return session
    ? {
        ...session,
        id: `${session.executionHostId}:trae:${session.sessionId}:${session.filePath}`,
        agent: 'trae' as const,
        accountHome: { variable: 'TRAECLI_HOME', path: home },
        codexHome: null,
        resumeCommand: buildAiVaultResumeCommand({
          agent: 'trae',
          sessionId: session.sessionId,
          cwd: session.cwd,
          platform
        })
      }
    : null
}
