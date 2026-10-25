/** Serve-readiness pieces shared by the desktop `--serve` host and orcad, so their stdout matches. */
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'

export async function renderServePairingQr(pairingUrl: string): Promise<string | null> {
  // Why dynamic: qrcode is only reachable from mobile pairing, so launch should
  // not parse it for the majority who never pair a device.
  const QRCode = await import('qrcode')
  try {
    return await QRCode.toString(pairingUrl, { type: 'terminal', small: true })
  } catch {
    try {
      return await QRCode.toString(pairingUrl, { type: 'utf8' })
    } catch {
      return null
    }
  }
}

/** The recipe line names this root, so it must be a real absolute directory. */
export function assertServeProjectRoot(projectRoot: string): string {
  if (!isAbsolute(projectRoot)) {
    throw new Error(`--serve-project-root must be absolute: ${projectRoot}`)
  }
  if (!statSync(projectRoot).isDirectory()) {
    throw new Error(`--serve-project-root must be a directory: ${projectRoot}`)
  }
  return projectRoot
}
