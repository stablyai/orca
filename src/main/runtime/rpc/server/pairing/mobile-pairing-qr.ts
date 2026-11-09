export type MobilePairingQrResult =
  | { ok: true; qrDataUrl: string; qrSize: number }
  | { ok: false; reason: 'encoding_failed' }

const QUIET_ZONE_MODULES = 4
const MODULE_PITCH_PX = 2

export async function encodeMobilePairingQr(pairingUrl: string): Promise<MobilePairingQrResult> {
  try {
    const { default: QRCode } = await import('qrcode')
    const qrCode = QRCode.create(pairingUrl, { errorCorrectionLevel: 'M' })
    const qrSize = (qrCode.modules.size + QUIET_ZONE_MODULES * 2) * MODULE_PITCH_PX
    const qrDataUrl = await QRCode.toDataURL(pairingUrl, {
      errorCorrectionLevel: 'M',
      margin: QUIET_ZONE_MODULES,
      scale: MODULE_PITCH_PX
    })
    return { ok: true, qrDataUrl, qrSize }
  } catch {
    return { ok: false, reason: 'encoding_failed' }
  }
}
