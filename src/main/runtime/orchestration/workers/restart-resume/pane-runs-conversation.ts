import type { OrcaRuntimeService } from '../../../orca-runtime'

/** Whether this pane's live agent runs this conversation now; a row restored from disk names only
 *  what ran there before. */
export function paneRunsConversation(
  runtime: Pick<OrcaRuntimeService, 'getAgentStatusRowsForPane'>,
  paneKey: string,
  sessionId: string
): boolean {
  return runtime
    .getAgentStatusRowsForPane(paneKey)
    .some(
      (row) =>
        !row.providerSessionOnly &&
        !row.restoredUnconfirmed &&
        row.providerSession?.id === sessionId
    )
}
