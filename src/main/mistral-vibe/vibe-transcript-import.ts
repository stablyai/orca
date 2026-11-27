/**
 * Transcript import for Mistral Vibe sessions.
 *
 * Vibe stores sessions in ~/.vibe/sessions/ (or under $VIBE_HOME).
 * ACP sessions run via vibe-acp which uses the same app-server as the interactive CLI.
 * Session data is persisted in a journal format that may be importable.
 *
 * TODO: Implement once vibe's session journal format is documented.
 * For now, transcript import is disabled (null) in the launch spec.
 */

import type { StructuredAgentTranscriptImport } from '../native-chat/conversation-adoption/structured-agent-cli-conversations'

export const VIBE_TRANSCRIPT_IMPORT: StructuredAgentTranscriptImport | null = null
