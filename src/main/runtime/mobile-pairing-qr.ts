export type MobilePairingQrResult =
  | { ok: true; qrDataUrl: string }
  | { ok: false; reason: 'encoding_failed' }

export async function encodeMobilePairingQr(pairingUrl: string): Promise<MobilePairingQrResult> {
  try {
    const { default: QRCode } = await import('qrcode')
    const qrDataUrl = await QRCode.toDataURL(pairingUrl, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 256
    })
    return { ok: true, qrDataUrl }
  } catch {
    return { ok: false, reason: 'encoding_failed' }
  }
}
