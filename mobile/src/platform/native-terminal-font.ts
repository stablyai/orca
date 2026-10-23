import {
  BRIDGE_TERMINAL_FONT_CHUNK_BYTES,
  terminalFontReadParamsSchema
} from '../mobile-web-shell/bridge/bridge-native-verbs'
import { readTerminalFontChunk } from '../storage/terminal-font'

/** The device side of `native.font.read`: one range of the font the user imported. */
export async function serveNativeTerminalFontVerb(params: unknown): Promise<unknown> {
  const { fileName, offset } = terminalFontReadParamsSchema.parse(params)
  return readTerminalFontChunk(fileName, offset, BRIDGE_TERMINAL_FONT_CHUNK_BYTES)
}
