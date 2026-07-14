import type { DesktopMobileE2EEV2Session } from './mobile-e2ee-v2-desktop-session'

export type MobileE2EEAuth = {
  type: 'e2ee_auth'
  deviceToken: string
  v?: 2
  transcriptHashB64?: string
}

export function isValidMobileE2EEAuthVersion(
  auth: MobileE2EEAuth,
  v2Session: DesktopMobileE2EEV2Session | null
): boolean {
  if (!v2Session) {
    return auth.v === undefined && auth.transcriptHashB64 === undefined
  }
  return (
    Object.keys(auth).sort().join(',') === 'deviceToken,transcriptHashB64,type,v' &&
    auth.v === 2 &&
    auth.transcriptHashB64 === v2Session.transcriptHashB64
  )
}
