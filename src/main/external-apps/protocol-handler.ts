import { app } from 'electron'

export function hasExternalAppHandler(url: string): boolean {
  try {
    return app.getApplicationNameForProtocol(url) !== ''
  } catch {
    return false
  }
}
