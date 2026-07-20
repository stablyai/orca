import { app } from 'electron'
import type { Store } from '../persistence'
import type { IPtyProvider } from '../providers/types'
import { HerdrCliHostTransport, localHerdrCommand } from './herdr-cli-host-transport'
import { HerdrPtyProvider } from './herdr-pty-provider'
import { createLocalHerdrPtyTargetResolver } from './herdr-project-pty-target'
import { createHerdrPtyTargetResolver } from './herdr-project-pty-target'
import type { SshConnection } from '../ssh/ssh-connection'
import { toSshExecutionHostId } from '../../shared/execution-host'
import { HerdrSshHostTransport } from './herdr-ssh-host-transport'
import {
  resolveHerdrBinarySource,
  resolveLocalHerdrExecutable,
  verifyManagedHerdrExecutable
} from './herdr-binary-source'
import { ensureManagedHerdrOnSsh } from './herdr-managed-ssh-provisioner'

export function createLocalHerdrPtyProvider(
  fallback: IPtyProvider,
  store: Store
): HerdrPtyProvider {
  let executable: string | null = null
  const commandFor = (args: string[]) => {
    if (!executable) {
      const source = resolveHerdrBinarySource(store.getSettings(), 'local')
      executable = resolveLocalHerdrExecutable({
        source,
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        platform: process.platform,
        arch: process.arch,
        developmentOverride: process.env.ORCA_HERDR_BINARY
      })
      if (source.kind === 'managed' && app.isPackaged) {
        verifyManagedHerdrExecutable(executable)
      }
    }
    return localHerdrCommand(executable)(args)
  }
  const transport = new HerdrCliHostTransport({ commandFor })
  return new HerdrPtyProvider(fallback, transport, createLocalHerdrPtyTargetResolver(store))
}

export function createSshHerdrPtyProvider(
  fallback: IPtyProvider,
  store: Store,
  connection: SshConnection,
  targetId: string
): HerdrPtyProvider {
  const source = resolveHerdrBinarySource(store.getSettings(), toSshExecutionHostId(targetId))
  const resolveExecutable = async (): Promise<string> => {
    if (source.kind === 'system') {
      return 'herdr'
    }
    if (source.kind === 'custom') {
      return source.path
    }
    return ensureManagedHerdrOnSsh(connection, process.resourcesPath)
  }
  return new HerdrPtyProvider(
    fallback,
    new HerdrSshHostTransport(connection, 15_000, resolveExecutable),
    createHerdrPtyTargetResolver(store, toSshExecutionHostId(targetId))
  )
}
