/**
 * The host-agnostic hostile-host driver: the real client-side relay deploy through a real
 * SshConnection, observed through the ladder's own calls and a {@link HostileHostObserver}.
 * The Docker matrix and the Windows SSH-host lanes both run cells through it.
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setAppEnvironment } from '../../shared/app-environment'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import type { SshTarget } from '../../shared/ssh-types'
import { SshConnection } from './ssh-connection'

export function installHostileHostAppEnvironment(): () => void {
  const userData = mkdtempSync(join(tmpdir(), 'orca-hostile-hosts-userdata-'))
  const { version } = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
  setAppEnvironment({
    getPath: (name) => (name === 'userData' ? userData : tmpdir()),
    getAppPath: () => process.cwd(),
    getVersion: () => version,
    isPackaged: () => false,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  })
  return () => removeTreeSync(userData)
}

export async function connectHostileHost(sshTarget: SshTarget): Promise<SshConnection> {
  const conn = new SshConnection(sshTarget, { onStateChange: () => {} })
  await conn.connect()
  return conn
}
