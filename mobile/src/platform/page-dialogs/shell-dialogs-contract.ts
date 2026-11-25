import type {
  BridgeDialogAnswer,
  BridgeDialogShowParams
} from '../../mobile-web-shell/bridge/native-capabilities/bridge-dialog-verb'

export type ShellDialogs = {
  show: (params: BridgeDialogShowParams) => Promise<BridgeDialogAnswer>
  dismiss: (token: string) => Promise<void>
}
