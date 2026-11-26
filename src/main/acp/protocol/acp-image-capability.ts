import type { AcpLaunchSpec } from '../launch/acp-launch-contract'
import type { AcpStructuredConnection } from '../process/acp-structured-connection'

export async function acpSessionAcceptsImages(session: {
  spec: Pick<AcpLaunchSpec, 'dialect'>
  connection: Pick<AcpStructuredConnection, 'initialize'>
}): Promise<boolean> {
  return (
    !session.spec.dialect.dropsPromptImages &&
    (await session.connection.initialize()).agentCapabilities?.promptCapabilities?.image === true
  )
}
