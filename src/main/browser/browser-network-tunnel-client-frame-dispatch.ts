import {
  BrowserNetworkTunnelOpcode,
  type BrowserNetworkTunnelFrame
} from '../../shared/browser-network-tunnel-protocol'

type BrowserNetworkTunnelClientFrameActions = {
  opened: () => void
  grantCredit: () => void
  deliverData: () => void
  halfClose: () => void
  close: () => void
  remoteFailure: (error: Error) => void
  invalid: () => void
}

export function dispatchBrowserNetworkTunnelClientFrame(
  frame: BrowserNetworkTunnelFrame,
  actions: BrowserNetworkTunnelClientFrameActions
): void {
  const action =
    frame.opcode === BrowserNetworkTunnelOpcode.Opened
      ? actions.opened
      : frame.opcode === BrowserNetworkTunnelOpcode.WindowUpdate
        ? actions.grantCredit
        : frame.opcode === BrowserNetworkTunnelOpcode.Data
          ? actions.deliverData
          : frame.opcode === BrowserNetworkTunnelOpcode.HalfClose
            ? actions.halfClose
            : frame.opcode === BrowserNetworkTunnelOpcode.Close
              ? actions.close
              : frame.opcode === BrowserNetworkTunnelOpcode.Error
                ? () =>
                    actions.remoteFailure(
                      new Error(
                        `Browser tunnel destination failed: ${new TextDecoder().decode(frame.payload) || 'destination_error'}`
                      )
                    )
                : actions.invalid
  action()
}
