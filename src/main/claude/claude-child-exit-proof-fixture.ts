import type { PipedChildProcess } from '@orca/process-host/process-spec'
import {
  spawnManagedProviderProcess,
  type ManagedProviderProcess
} from '../provider-process/managed-provider-process'
import { claudeChildClosePolicy, claudeChildCloseProven } from './claude-child-exit-proof-ladder'

const managedChildren = new WeakMap<object, ManagedProviderProcess>()

/** `closePlatform` picks the close rules; the spawn itself always skips the POSIX supervisor. */
export function managedChild(
  child: PipedChildProcess,
  closePlatform: NodeJS.Platform = 'linux'
): ManagedProviderProcess {
  const existing = managedChildren.get(child)
  if (existing) {
    return existing
  }
  const managed = spawnManagedProviderProcess(
    { command: 'fixture-provider', args: [] },
    {
      spawnImpl: () => child,
      platform: 'win32',
      site: 'claude-proof-fixture',
      policy: (supervised) => claudeChildClosePolicy(supervised, closePlatform),
      acceptClose: claudeChildCloseProven
    }
  )
  managedChildren.set(child, managed)
  return managed
}
