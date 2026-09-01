import { assertClipboardImageByteLengthWithinLimit } from '../../shared/clipboard-image'
import { saveClipboardImageBase64ThroughRuntime } from '../../shared/clipboard-image-upload-protocol'
import { callRuntimeEnvironment } from '../ipc/runtime-environment-transport-routing'

export function saveClipboardImageBufferInRuntime(
  userDataPath: string,
  runtimeEnvironmentId: string,
  buffer: Buffer,
  connectionId: string | null = null
): Promise<string> {
  assertClipboardImageByteLengthWithinLimit(buffer.byteLength)
  return saveClipboardImageBase64ThroughRuntime(
    (method, params, timeoutMs) =>
      callRuntimeEnvironment(userDataPath, runtimeEnvironmentId, method, params, timeoutMs),
    buffer.toString('base64'),
    connectionId
  )
}
