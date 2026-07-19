import { join } from 'node:path'
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

function managedHerdrExecutable(): string {
  const configured = process.env.ORCA_HERDR_BINARY?.trim()
  if (configured) return configured
  if (!app.isPackaged) return 'herdr'
  const executable = process.platform === 'win32' ? 'herdr.exe' : 'herdr'
  return join(process.resourcesPath, 'herdr', `${process.platform}-${process.arch}`, executable)
}

export function createLocalHerdrPtyProvider(
  fallback: IPtyProvider,
  store: Store
): HerdrPtyProvider {
  const transport = new HerdrCliHostTransport({
    commandFor: localHerdrCommand(managedHerdrExecutable())
  })
  return new HerdrPtyProvider(fallback, transport, createLocalHerdrPtyTargetResolver(store))
}

export function createSshHerdrPtyProvider(
  fallback: IPtyProvider,
  store: Store,
  connection: SshConnection,
  targetId: string
): HerdrPtyProvider {
  return new HerdrPtyProvider(
    fallback,
    new HerdrSshHostTransport(connection),
    createHerdrPtyTargetResolver(store, toSshExecutionHostId(targetId))
  )
}
