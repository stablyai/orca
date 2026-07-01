import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { basename } from 'node:path'
import type { UpdateInfo } from 'builder-util-runtime'
import {
  EXPECTED_WINDOWS_UPDATE_SIGNER_THUMBPRINT,
  runWindowsSignatureCapabilityPreflight,
  verifyWindowsUpdaterAuthenticodeSignature
} from './windows-updater-authenticode-signature'
import type { ElectronAutoUpdater } from './electron-updater-loader'

export const EXPECTED_WINDOWS_UPDATE_PUBLISHER = 'SignPath Foundation'
export { EXPECTED_WINDOWS_UPDATE_SIGNER_THUMBPRINT }
export const WINDOWS_UPDATER_SIGNATURE_VERIFICATION_ERROR_CODE =
  'ERR_ORCA_WINDOWS_UPDATER_SIGNATURE_VERIFICATION'
export const UPSTREAM_WINDOWS_UPDATER_INVALID_SIGNATURE_CODE = 'ERR_UPDATER_INVALID_SIGNATURE'
export const WINDOWS_UPDATER_SIGNATURE_VERIFICATION_ERROR_MESSAGE =
  'Orca could not verify the update publisher.'

type WindowsSignatureUpdater = ElectronAutoUpdater & {
  installerPath?: unknown
  verifySignature?: (installerPath: string) => Promise<string | null>
}

type UpdateFileMetadata = {
  url?: unknown
  sha512?: unknown
}

export class WindowsUpdaterSignatureVerificationError extends Error {
  readonly code = WINDOWS_UPDATER_SIGNATURE_VERIFICATION_ERROR_CODE

  constructor(detail?: string, cause?: unknown) {
    const message = detail
      ? `${WINDOWS_UPDATER_SIGNATURE_VERIFICATION_ERROR_MESSAGE} ${detail}`
      : WINDOWS_UPDATER_SIGNATURE_VERIFICATION_ERROR_MESSAGE
    super(message)
    this.name = 'WindowsUpdaterSignatureVerificationError'
    if (cause !== undefined) {
      ;(this as Error & { cause?: unknown }).cause = cause
    }
  }
}

export function createWindowsUpdaterSignatureVerificationError(
  detail?: string,
  cause?: unknown
): WindowsUpdaterSignatureVerificationError {
  return new WindowsUpdaterSignatureVerificationError(detail, cause)
}

export function isWindowsUpdaterSignatureVerificationError(error: unknown): boolean {
  const code = readErrorCode(error)
  return (
    code === WINDOWS_UPDATER_SIGNATURE_VERIFICATION_ERROR_CODE ||
    code === UPSTREAM_WINDOWS_UPDATER_INVALID_SIGNATURE_CODE
  )
}

export function installWindowsUpdaterSignatureVerification(autoUpdater: ElectronAutoUpdater): void {
  if (process.platform !== 'win32') {
    return
  }

  const windowsUpdater = autoUpdater as WindowsSignatureUpdater
  windowsUpdater.verifySignature = (installerPath: string) =>
    verifyWindowsUpdaterInstaller(windowsUpdater, installerPath)
}

export async function verifyWindowsUpdaterInstaller(
  _autoUpdater: ElectronAutoUpdater,
  installerPath: string
): Promise<string | null> {
  if (process.platform !== 'win32') {
    return null
  }

  if (!installerPath.trim()) {
    return 'Windows update installer path is missing.'
  }

  const preflightFailure = await runWindowsSignatureCapabilityPreflight()
  if (preflightFailure !== null) {
    return preflightFailure
  }

  const authenticodeFailure = await verifyWindowsUpdaterAuthenticodeSignature(installerPath, [
    EXPECTED_WINDOWS_UPDATE_PUBLISHER
  ])
  if (authenticodeFailure !== null) {
    return authenticodeFailure
  }

  return null
}

export function readWindowsUpdaterInstallerPath(autoUpdater: ElectronAutoUpdater): string | null {
  let installerPath: unknown
  try {
    installerPath = Reflect.get(autoUpdater, 'installerPath')
  } catch {
    return null
  }

  return typeof installerPath === 'string' && installerPath.trim() ? installerPath : null
}

export function readWindowsUpdaterExpectedSha512(updateInfo: UpdateInfo): string | null {
  const metadata = updateInfo as UpdateInfo & {
    files?: UpdateFileMetadata[]
    path?: unknown
    sha512?: unknown
  }
  if (Array.isArray(metadata.files)) {
    const installerFiles = metadata.files.filter((file) => isWindowsInstallerUrl(file.url))

    if (isWindowsInstallerUrl(metadata.path)) {
      const selectedInstallerFiles = installerFiles.filter(
        (file) => normalizeInstallerUrl(file.url) === normalizeInstallerUrl(metadata.path)
      )
      return selectedInstallerFiles.length === 1
        ? readNonEmptyString(selectedInstallerFiles[0]?.sha512)
        : null
    }

    if (installerFiles.length !== 1) {
      return null
    }

    return readNonEmptyString(installerFiles[0]?.sha512)
  }

  if (isWindowsInstallerUrl(metadata.path)) {
    return readNonEmptyString(metadata.sha512)
  }

  return null
}

export async function hashWindowsUpdaterInstaller(installerPath: string): Promise<string> {
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(installerPath)) {
    hash.update(chunk)
  }
  return hash.digest('base64')
}

function isWindowsInstallerUrl(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false
  }
  return normalizeInstallerUrl(value).endsWith('.exe')
}

function normalizeInstallerUrl(value: unknown): string {
  return typeof value === 'string' ? basename(value.split(/[?#]/u)[0] ?? '').toLowerCase() : ''
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return null
  }
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}
