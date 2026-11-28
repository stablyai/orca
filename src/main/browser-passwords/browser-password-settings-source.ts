export type BrowserPasswordSettings = {
  offerToSave: boolean
  fillRequiresReauth: boolean
}

const UNCONFIGURED: BrowserPasswordSettings = {
  offerToSave: false,
  fillRequiresReauth: false
}

let readSettings: () => BrowserPasswordSettings = () => UNCONFIGURED

export function setBrowserPasswordSettingsSource(source: () => BrowserPasswordSettings): void {
  readSettings = source
}

export function browserPasswordSettings(): BrowserPasswordSettings {
  return readSettings()
}
