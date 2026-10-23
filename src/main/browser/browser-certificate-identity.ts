import { normalizeCertificateError } from '../../shared/browser-certificate-errors'
import { getPemCertificateSha256 } from '../../shared/pem-certificate-sha256'

export { normalizeCertificateError }

export const SUPPORTED_CERTIFICATE_ERROR = 'ERR_CERT_AUTHORITY_INVALID'
export const SUPPORTED_CERTIFICATE_ERROR_CODE = -202

export function getSupportedCertificateErrorCode(error: string): number | null {
  return normalizeCertificateError(error) === SUPPORTED_CERTIFICATE_ERROR
    ? SUPPORTED_CERTIFICATE_ERROR_CODE
    : null
}

export function getLeafCertificateSha256(certificate: Electron.Certificate): string | null {
  return getPemCertificateSha256(certificate.data)
}
