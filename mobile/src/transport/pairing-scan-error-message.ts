const PAIRING_QR_INSTRUCTIONS =
  'In Orca on your computer, go to Settings > Mobile and scan the generated Pairing QR.'

export function getPairingScanErrorMessage(data: string): string {
  const trimmedData = data.trim().toLowerCase()
  if (trimmedData.startsWith('http://') || trimmedData.startsWith('https://')) {
    return `That QR opens a link, not a desktop pairing code. ${PAIRING_QR_INSTRUCTIONS}`
  }
  return `This is not a desktop pairing QR. ${PAIRING_QR_INSTRUCTIONS}`
}
