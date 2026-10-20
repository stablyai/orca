import { readFileSync } from 'node:fs'
import { writeFileAtomically } from '../codex-accounts/fs-utils'

/** Main-owned because main is what turns capture protection on; read once, then cached. */
export class IncognitoScreenCapturePreference {
  private allow: boolean

  constructor(private readonly filePath: string) {
    this.allow = readAllowScreenCapture(filePath)
  }

  allowScreenCapture(): boolean {
    return this.allow
  }

  setAllowScreenCapture(allow: boolean): void {
    writeFileAtomically(this.filePath, JSON.stringify({ allowScreenCapture: allow }))
    this.allow = allow
  }
}

function readAllowScreenCapture(filePath: string): boolean {
  try {
    const value: unknown = JSON.parse(readFileSync(filePath, 'utf-8'))
    return (
      typeof value === 'object' &&
      value !== null &&
      'allowScreenCapture' in value &&
      value.allowScreenCapture === true
    )
  } catch {
    // Missing or corrupt reads as the safe default: hide from capture.
    return false
  }
}
