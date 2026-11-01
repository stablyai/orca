import { AcpAgentError } from './acp-errors'

export function temporaryAcpStartupAnswer(error: unknown): boolean {
  return (
    error instanceof AcpAgentError &&
    error.code === -32603 &&
    typeof error.data === 'object' &&
    error.data !== null &&
    'errorName' in error.data &&
    (error.data.errorName === 'ServerUnavailable' || error.data.errorName === 'CatalogNotReady')
  )
}
