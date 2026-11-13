import type { AcpStructuredConnection } from '../process/acp-structured-connection'

export async function acpSessionAcceptsImages(session: {
  connection: Pick<AcpStructuredConnection, 'initialize'>
}): Promise<boolean> {
  return (
    (await session.connection.initialize()).agentCapabilities?.promptCapabilities?.image === true
  )
}
