import {
  pluginError,
  pluginFailure,
  pluginResult,
  type PluginEnvelope
} from '../../../../shared/plugins/frames/plugin-protocol'
import {
  PLUGIN_PANEL_BYTES_RESULT_MAX_BYTES,
  pluginPanelBytesTooLarge
} from '../../../../shared/plugins/workers/plugin-panel-bridge-protocol'

/**
 * What a panel handler's answer leaves the worker as. A typed array goes as an ArrayBuffer of
 * exactly its own range (`plugin.requestBytes`), never the whole buffer behind it.
 */
export function pluginPanelAnswer(id: number, name: string, output: unknown): PluginEnvelope {
  const view = ArrayBuffer.isView(output) ? output : null
  const size = view?.byteLength ?? (output instanceof ArrayBuffer ? output.byteLength : 0)
  // Why here: binary data the host would refuse must not cross the process boundary.
  if (size > PLUGIN_PANEL_BYTES_RESULT_MAX_BYTES) {
    return pluginFailure(id, pluginError('too_large', pluginPanelBytesTooLarge(name)))
  }
  return pluginResult(id, view ? viewBytes(view) : output)
}

function viewBytes({ buffer, byteOffset, byteLength }: ArrayBufferView): ArrayBuffer {
  return buffer instanceof ArrayBuffer && byteOffset === 0 && byteLength === buffer.byteLength
    ? buffer
    : new Uint8Array(buffer, byteOffset, byteLength).slice().buffer
}
