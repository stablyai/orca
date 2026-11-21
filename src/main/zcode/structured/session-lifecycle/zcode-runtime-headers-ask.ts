import type { ZcodeAppServerConnection } from '../../app-server/zcode-app-server-connection-types'
import { readRecord, readString } from '../catalog/zcode-model-catalog-rows'
import { formatZcodeModelOption } from '../launch/zcode-structured-launch-resolution'
import type { ZcodeChatCredentials } from '../credentials/zcode-chat-credentials'
import type { ZcodeStructuredLane } from '../timeline/zcode-structured-lane'
import type { ZcodeStructuredOptions } from '../options/zcode-structured-options'
import { journalZcodeModelSwitchNotice } from './zcode-model-switch-notice'

// The runtime-headers ask names the model each turn routes on — the provider's own account of
// its routing. First ask of a turn records it; a turn routed differently than the last journals
// the switch. Picks never touch this state, so the notice reflects what actually runs.

/** Answers `interaction/requestProviderRuntimeHeaders`, journaling one notice per real switch. */
export class ZcodeRuntimeHeadersAsks {
  private lastNoticeTurnId: string | null = null
  private lastTurnModelId: string | null = null

  answer(input: {
    connection: Pick<ZcodeAppServerConnection, 'respond' | 'respondWithError'>
    params: unknown
    id: number | string
    credentials: ZcodeChatCredentials | null
    options: ZcodeStructuredOptions
    lane: ZcodeStructuredLane | null
    providerSessionId: string | null
    now: () => number
  }): void {
    const ask = readRecord(input.params)
    const askProvider = readString(ask?.providerId)
    const askModel =
      readString(readRecord(ask?.modelSelection)?.modelId) ?? readString(ask?.modelId)
    const askTurnId = readString(ask?.turnId)
    if (askProvider && askModel && askTurnId && askTurnId !== this.lastNoticeTurnId) {
      const reported = formatZcodeModelOption({ providerId: askProvider, modelId: askModel })
      if (
        input.lane &&
        input.providerSessionId &&
        this.lastTurnModelId !== null &&
        reported !== this.lastTurnModelId
      ) {
        journalZcodeModelSwitchNotice({
          lane: input.lane,
          providerSessionId: input.providerSessionId,
          options: input.options,
          from: this.lastTurnModelId,
          to: reported,
          at: input.now()
        })
      }
      this.lastTurnModelId = reported
      this.lastNoticeTurnId = askTurnId
    }
    if (input.credentials) {
      input.connection.respond(input.id, {
        headersApplied: true,
        requestAuth: { apiKey: input.credentials.apiKey }
      })
    } else {
      input.connection.respondWithError(input.id, -32000, 'no coding plan key is available to Orca')
    }
  }
}
