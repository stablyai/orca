import type { WebContents } from 'electron'
import type { CapturePaintHold } from './cdp-screenshot'
import {
  isDesktopOwnedBrowserViewRecord,
  type DesktopOwnedBrowserViewRecord
} from './desktop-owned-browser-view-admission'

export type DesktopOwnedBrowserCaptureRequest =
  | { kind: 'full-page'; format: 'png' | 'jpeg' }
  | { kind: 'screenshot'; params: Record<string, unknown> | undefined }

export type DesktopOwnedBrowserCaptureHandler = (
  request: DesktopOwnedBrowserCaptureRequest,
  holdPaint: CapturePaintHold
) => Promise<{ data: string }>

type CaptureRegistration = {
  record: DesktopOwnedBrowserViewRecord
  capture: DesktopOwnedBrowserCaptureHandler
}

const registrations = new WeakMap<WebContents, CaptureRegistration>()

export function registerDesktopOwnedBrowserCapture(
  record: DesktopOwnedBrowserViewRecord,
  capture: DesktopOwnedBrowserCaptureHandler
): () => void {
  if (
    !isDesktopOwnedBrowserViewRecord(record) ||
    record.webContents.isDestroyed() ||
    record.view.webContents !== record.webContents ||
    record.webContents.session !== record.session ||
    registrations.has(record.webContents)
  ) {
    throw new Error('Desktop-owned browser capture identity is invalid or already registered')
  }
  const registration = { record, capture }
  registrations.set(record.webContents, registration)
  return () => {
    if (registrations.get(record.webContents) === registration) {
      registrations.delete(record.webContents)
    }
  }
}

export function getDesktopOwnedBrowserCapture(
  webContents: WebContents
): DesktopOwnedBrowserCaptureHandler | null {
  const registration = registrations.get(webContents)
  if (!registration) {
    return null
  }
  const { record } = registration
  if (
    !isDesktopOwnedBrowserViewRecord(record) ||
    webContents.isDestroyed() ||
    record.view.webContents !== webContents ||
    webContents.session !== record.session
  ) {
    throw new Error('Desktop-owned browser capture lost its retained identity')
  }
  return registration.capture
}
