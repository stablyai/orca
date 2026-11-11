import { SessionSearchCatalogCredit } from './session-search-catalog-credit'
import { createAiVaultScanCancelledError } from '../ai-vault/ai-vault-scan-cancellation'
import type {
  SearchWorkerCommand,
  SearchWorkerResponse
} from './worker/session-search-worker-protocol'

type CatalogCommand = Extract<SearchWorkerCommand, { op: 'catalog' | 'candidates' | 'work' }>

/** Credits and epoch fences cover all roots sharing the writer request lane. */
export class SessionSearchCatalogTransport {
  private readonly credit = new SessionSearchCatalogCredit()
  private sequence = 0
  constructor(
    private readonly epoch: () => number,
    private readonly prepare: () => Promise<void>,
    private readonly send: (command: SearchWorkerCommand) => Promise<SearchWorkerResponse>
  ) {}
  async request(command: CatalogCommand): Promise<SearchWorkerResponse> {
    await this.prepare()
    const epoch = this.epoch()
    const size = JSON.stringify(command).length * 2 + 1024
    const input = command.command
    const rows =
      'rows' in input
        ? input.rows
        : 'keys' in input
          ? input.keys
          : 'inputs' in input
            ? input.inputs
            : 'outcomes' in input
              ? input.outcomes
              : 'receipts' in input
                ? input.receipts
                : 'paths' in input
                  ? input.paths
                  : undefined
    if (rows && (rows.length > 256 || (rows.length > 1 && size > 256 * 1024))) {
      throw new Error('Session catalog request exceeds page budget')
    }
    const release = await this.credit.retain(size + 256 * 1024)
    try {
      if (epoch !== this.epoch()) {
        throw createAiVaultScanCancelledError()
      }
      const pageSequence = ++this.sequence
      const response = await this.send({
        ...command,
        catalogPage: {
          runtimeEpoch: epoch,
          sourceId: 'scope' in input ? input.scope : command.op,
          observationEpoch: 'generation' in input ? input.generation : pageSequence,
          pageSequence
        }
      })
      if (epoch !== this.epoch()) {
        throw createAiVaultScanCancelledError()
      }
      return response
    } finally {
      release()
    }
  }
}
