export type TerminalHistorySeedTransferManifest = {
  chunkCount: number
  codeUnits: number
  sha256: string
}

export type CreateOrAttachHistorySeedPayload = {
  historySeed?: string
  historySeedTransferId?: string
}

export type StartHistorySeedTransferRequest = {
  id: string
  type: 'startHistorySeedTransfer'
  payload: TerminalHistorySeedTransferManifest
}

export type AppendHistorySeedTransferRequest = {
  id: string
  type: 'appendHistorySeedTransfer'
  payload: {
    transferId: string
    index: number
    data: string
  }
}

export type FinishHistorySeedTransferRequest = {
  id: string
  type: 'finishHistorySeedTransfer'
  payload: { transferId: string }
}

export type AbortHistorySeedTransferRequest = {
  id: string
  type: 'abortHistorySeedTransfer'
  payload: { transferId: string }
}

export type TerminalHistorySeedTransferRequest =
  | StartHistorySeedTransferRequest
  | AppendHistorySeedTransferRequest
  | FinishHistorySeedTransferRequest
  | AbortHistorySeedTransferRequest
