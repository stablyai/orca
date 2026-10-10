/**
 * The terminal stream wire format has exactly one definition: `src/shared/terminal-stream-protocol.ts`.
 *
 * Mobile used to hand-copy the codec and 7 of the 17 opcodes. Drift was silent — nothing failed
 * when the host gained an opcode, because the vendored `isTerminalStreamOpcode` rejected the
 * unknown value and `decodeTerminalStreamFrame` returned null, dropping the entire frame rather
 * than the one field mobile did not understand. That is how STA-3482 lost terminal output on
 * phones. Re-exporting keeps mobile decoding every frame the host can send; opcodes mobile has
 * no behavior for are ignored by the frame handler, which `terminal-stream-opcode-coverage.test.ts`
 * pins explicitly.
 *
 * Metro resolves this via `config.watchFolders` in metro.config.js.
 */
export {
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  decodeTerminalStreamText,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText,
  TerminalStreamOpcode,
  type TerminalStreamFrame
} from '../../../src/shared/terminal-stream-protocol'
