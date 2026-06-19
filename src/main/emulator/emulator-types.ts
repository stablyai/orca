export type EmulatorSessionInfo = {
  deviceUdid: string
  wsUrl: string
  streamUrl: string
  axUrl?: string
  helperPid?: number
}

export type EmulatorCliTarget = {
  worktreeId?: string
  deviceUdid?: string
  emulatorId?: string // Orca-generated id from list (for stability, like browserPageId)
}
