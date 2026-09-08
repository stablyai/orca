// agent/src/relay/browser-profile-types.ts
// Shared types for the browser-profile-detect.ts family of modules (browser
// detection, cookie-decryption primitives) — split out to avoid circular
// imports between them.

export type BrowserProfile = { name: string; directory: string }

export type DetectedBrowser = {
  family: string // BrowserSessionProfileSource['browserFamily'] on the frontend side
  label: string
  profiles: BrowserProfile[]
  selectedProfile: string
}
