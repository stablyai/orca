import {
  ORCAD_CANCELED_STOPS_DIRNAME,
  OrcadCanceledStopReceiptSchema,
  orcadCanceledStopReceiptFilename
} from '../../shared/orcad-managed-stop-cancellation'
import {
  OrcadManagedStopRequestSchema,
  type OrcadManagedStopRequest
} from '../../shared/orcad-managed-stop-request'
import { readBoundedOrcadRemoteRecord } from './orcad-remote-record-file'
import { joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'
import type { SshConnection } from './ssh-connection'
import { RELAY_REMOTE_DIR } from './relay-protocol'

export async function verifyRemoteOrcadCanceledStopReceipt(
  options: {
    conn: SshConnection
    host: RemoteHostPlatform
    remoteHome: string
    signal?: AbortSignal
  },
  request: OrcadManagedStopRequest
): Promise<void> {
  const expected = OrcadManagedStopRequestSchema.parse(request)
  const path = joinRemotePath(
    options.host,
    options.remoteHome,
    RELAY_REMOTE_DIR,
    ORCAD_CANCELED_STOPS_DIRNAME,
    orcadCanceledStopReceiptFilename(expected.authority.transactionId)
  )
  const receipt = OrcadCanceledStopReceiptSchema.parse(
    JSON.parse(await readBoundedOrcadRemoteRecord(options, path, 64 * 1024))
  )
  if (JSON.stringify(receipt.request) !== JSON.stringify(expected)) {
    throw new Error('The durable cancellation receipt belongs to a different stop request.')
  }
}
