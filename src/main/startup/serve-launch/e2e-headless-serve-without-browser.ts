import { app } from 'electron'

/** E2E only: a serve host with no browser of its own, as the WSL distro's server is. Never packaged. */
export function e2eHeadlessServeWithoutBrowser(): boolean {
  return (
    !app.isPackaged &&
    process.env.ORCA_E2E_HEADLESS === '1' &&
    process.env.ORCA_E2E_HEADLESS_SERVE_WITHOUT_BROWSER === '1'
  )
}
