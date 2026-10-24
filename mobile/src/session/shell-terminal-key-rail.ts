import type {
  BridgeTerminalKeyId,
  BridgeTerminalKeyRail
} from '../mobile-web-shell/bridge/bridge-terminal-key'

const NO_RAIL_KEYS: BridgeTerminalKeyRail = []

/**
 * The keys the shell's rail shows beside this screen, which then drops them from its own row;
 * `onKey` takes each press on it. Natively there is no shell around the screen, so none.
 */
export function useShellTerminalKeyRail(
  _shown: boolean,
  _onKey: (key: BridgeTerminalKeyId) => void
): BridgeTerminalKeyRail {
  return NO_RAIL_KEYS
}
