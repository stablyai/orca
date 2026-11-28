import { isAbsolute, join, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { defaultRexLocalEndpoint } from '../../../providers/rex-pty/rex-local-endpoint'
import { getAppEnvironment } from '../../../../shared/app-lifecycle/app-environment'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import { RexPtyProvider } from '../../../providers/rex-pty/rex-pty-provider'
import { RexSessionStore } from '../../../providers/rex-pty/rex-session-store'
import { createRexSnapshotDecoder } from '../../../providers/rex-pty/rex-snapshot-worker'
import { setRexPtyProvider } from './registry'

let installed = false

/** Inert registration; turning preference off does not change saved session routing. */
export function registerRexLocalProvider(getSettings?: () => GlobalSettings): void {
  if (installed) {
    return
  }
  const app = getAppEnvironment()
  const profile = app.getPath('userData')
  const fixtureSocket = process.env.ORCA_E2E_REX_SOCKET
  const fixtureWasm = process.env.ORCA_E2E_REX_WASM
  const fixture = !app.isPackaged() && fixtureSocket && fixtureWasm
  if (
    fixture &&
    (!process.env.ORCA_E2E_HOME_DIR ||
      resolve(homedir()) !== resolve(process.env.ORCA_E2E_HOME_DIR) ||
      resolve(app.getPath('home')) !== resolve(homedir()) ||
      process.env.ORCA_E2E_USER_DATA_DIR !== profile ||
      !resolve(profile).startsWith(resolve(tmpdir()).concat('/')) ||
      !resolve(fixtureSocket).startsWith(resolve(tmpdir()).concat('/')) ||
      !isAbsolute(fixtureSocket) ||
      !isAbsolute(fixtureWasm))
  ) {
    throw new Error('Rex E2E requires isolated profile and socket')
  }
  const endpoint = fixture ? fixtureSocket : defaultRexLocalEndpoint()
  if (!endpoint) {
    return
  }
  const wasm = fixture ? fixtureWasm : join(profile, 'rex', 'ghostty-vt-1.0.2-small.wasm')
  setRexPtyProvider(
    new RexPtyProvider(
      endpoint,
      new RexSessionStore(join(profile, 'rex-live-pty')),
      createRexSnapshotDecoder(wasm)
    ),
    () => getSettings?.()?.terminalLocalBackend === 'rex'
  )
  installed = true
}
