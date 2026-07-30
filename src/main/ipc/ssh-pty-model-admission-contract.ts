export type SshPtyModelAdmissionKey = Readonly<{
  ptyId: string
  providerGeneration: number
}>

export type SshPtyModelAdmissionReceipt = Readonly<{
  ptyId: string
  providerGeneration: number
  sequence: number
}>

export type SshPtyModelAdmissionDebugSnapshot = Readonly<{
  sourceUnits: number
  bytes: number
  pressureFrames: number
  pressureBytes: number
  pausedPtys: number
  migratingPtys: number
}>

export type SshPtyModelAdmissionOptions = {
  perPtyHighSourceUnits?: number
  perPtyHighBytes?: number
  perPtyLowSourceUnits?: number
  perPtyLowBytes?: number
  globalHighSourceUnits?: number
  globalHighBytes?: number
  globalLowSourceUnits?: number
  globalLowBytes?: number
  pressureMaxFrames?: number
  pressureMaxBytes?: number
  pauseProvider?: (key: SshPtyModelAdmissionKey) => boolean
  resumeProvider?: (key: SshPtyModelAdmissionKey) => void
  closeProvider?: (providerGeneration: number, reason: string) => void
}
