import { decryptBytes } from './e2ee'
import { websocketPayloadToUint8 } from './websocket-payload-bytes'

export async function handleMobileRpcSocketBinaryMessage(args: {
  rawData: unknown
  key: Uint8Array
  isCurrent: () => boolean
  onFrame: (plaintext: Uint8Array) => void
}): Promise<void> {
  const bytes = await websocketPayloadToUint8(args.rawData)
  if (!args.isCurrent() || !bytes) {
    return
  }
  const plaintextBytes = decryptBytes(bytes, args.key)
  if (plaintextBytes) {
    args.onFrame(plaintextBytes)
  }
}
