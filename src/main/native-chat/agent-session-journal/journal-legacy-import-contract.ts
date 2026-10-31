import type { AdoptedTranscriptSource } from './adopted-transcript-source'
import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { NativeChatTurnLifecycle } from '../../../shared/native-chat-types'
import type { ResolveSessionFileOptions } from '../session-file-resolver'
import type { JournalReplacementItem } from './journal-epoch-replacement'
import type { JournalPayloadLimits } from './journal-payload-bounds'
export type LegacyImportOptions = ResolveSessionFileOptions & {
  filePath?: string
  source?: AdoptedTranscriptSource
  limits?: JournalPayloadLimits
  decodedMessageIdentities?: true
  signal?: AbortSignal
}

export type LegacyImportResult =
  | {
      ok: true
      epoch: string
      cursor: AgentJournalCursor
      imported: number
      replaced: boolean
    }
  | { ok: false; error: string }

export type PreparedLegacyImport =
  | {
      ok: true
      items: JournalReplacementItem[]
      sourceEmpty: boolean
      latestTurn?: NativeChatTurnLifecycle
      /** Each turn's last lifecycle state, so a later import can replace an Orca-settled record. */
      turnStates?: ReadonlyMap<string, NativeChatTurnLifecycle>
      /** The open latest turn ended on a row only a legacy format calls complete: outcome unknown. */
      latestTurnAmbiguous?: true
      /** The latest turn's first user row, from the boundary that opened it; null if not retained.
       *  Absent where the read marks no turns in line order. */
      latestTurnOpener?: string | null
    }
  | { ok: false; error: string }
