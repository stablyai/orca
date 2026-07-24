import type { DesktopMobileE2EEV2Session } from './mobile-e2ee-v2-desktop-session'
import { publicKeyFromBase64 } from './e2ee-crypto'
import { parseRemoteRuntimeJsonText } from '../../../shared/remote-runtime-request-frames'

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

export function authenticateMobileE2EE<TDevice extends { deviceToken: string }>(args: {
  plaintext: string
  v2Session: DesktopMobileE2EEV2Session | null
  resolveDevice: (token: string) => TDevice | null
}): { ok: true; device: TDevice } | { ok: false; code: 'bad_auth' | 'unauthorized' } {
  let auth: MobileE2EEAuth
  try {
    auth = parseRemoteRuntimeJsonText(args.plaintext) as MobileE2EEAuth
  } catch {
    return { ok: false, code: 'bad_auth' }
  }
  if (
    auth.type !== 'e2ee_auth' ||
    !auth.deviceToken ||
    !isValidMobileE2EEAuthVersion(auth, args.v2Session)
  ) {
    return { ok: false, code: 'bad_auth' }
  }
  const device = args.resolveDevice(auth.deviceToken)
  return device?.deviceToken === auth.deviceToken
    ? { ok: true, device }
    : { ok: false, code: 'unauthorized' }
}

export function decodeMobileE2EEPublicKey(value: string): Uint8Array | null {
  try {
    return publicKeyFromBase64(value)
  } catch {
    return null
  }
}
