// Why: dynamic import — pairing is the only consumer, so IPC startup should
// not parse the qrcode bundle for users who never pair a device.
export async function encodePairingQrDataUrl(pairingUrl: string): Promise<string> {
  const { default: QRCode } = await import('qrcode')
  return QRCode.toDataURL(pairingUrl, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 256
  })
}
