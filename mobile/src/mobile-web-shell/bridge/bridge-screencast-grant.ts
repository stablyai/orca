// Use a bare camelCase grant token: manifest grammar permits it or a full native.domain.action verb, not browser.screencast.
// Negotiate the lane before mounting; older apps leave unsupported routes native instead of showing a pane waiting for frames they cannot encode.
export const BRIDGE_SCREENCAST_BINARY_GRANT = 'screencastBinary'

export type BridgeBinaryLaneVerdict = 'serve' | 'not-asked' | 'ungranted'

// Require both a binary listener request and this route’s grant; avoid encoding for absent listeners or granting another route’s capability.
// Missing grant keeps JSON streaming and logs locally; nothing changes on the wire.
export function bridgeBinaryLaneVerdict(args: {
  wantsBinary: boolean | undefined
  granted: readonly string[]
}): BridgeBinaryLaneVerdict {
  if (args.wantsBinary !== true) {
    return 'not-asked'
  }
  return args.granted.includes(BRIDGE_SCREENCAST_BINARY_GRANT) ? 'serve' : 'ungranted'
}
