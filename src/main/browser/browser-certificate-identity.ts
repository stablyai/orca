import { createHash } from 'node:crypto'

import { normalizeCertificateError } from '../../shared/browser-certificate-errors'

export { normalizeCertificateError }

export const SUPPORTED_CERTIFICATE_ERROR = 'ERR_CERT_AUTHORITY_INVALID'
export const SUPPORTED_CERTIFICATE_ERROR_CODE = -202

export function getSupportedCertificateErrorCode(error: string): number | null {
  return normalizeCertificateError(error) === SUPPORTED_CERTIFICATE_ERROR
    ? SUPPORTED_CERTIFICATE_ERROR_CODE
    : null
}

export function getLeafCertificateSha256(certificate: Electron.Certificate): string | null {
  const match = certificate.data.match(
    /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/
  )
  if (!match) {
    return null
  }
  try {
    const der = Buffer.from(match[1].replace(/\s+/g, ''), 'base64')
    return der.length > 0 ? createHash('sha256').update(der).digest('hex') : null
  } catch {
    return null
  }
}
