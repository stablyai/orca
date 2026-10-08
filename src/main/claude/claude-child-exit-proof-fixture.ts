import type { EventEmitter } from 'node:events'
import type { spawnProcess, SpawnedProcess } from '../../shared/child-process/run-process'
import {
  spawnManagedProviderProcess,
  type ManagedProviderProcess
} from '../provider-process/managed-provider-process'
import { claudeChildClosePolicy, claudeChildCloseProven } from './claude-child-exit-proof-ladder'

const managedChildren = new WeakMap<object, ManagedProviderProcess>()

/** `closePlatform` picks the close rules; the spawn itself always skips the POSIX supervisor. */
export function managedChild(
  child: Pick<SpawnedProcess, 'pid' | 'kill' | 'stdin' | 'stderr'> & EventEmitter,
  closePlatform: NodeJS.Platform = 'linux'
): ManagedProviderProcess {
  const existing = managedChildren.get(child)
  if (existing) {
    return existing
  }
  const managed = spawnManagedProviderProcess(
    { command: 'fixture-provider', args: [] },
    {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The managed process reads only the fixture's owned pid, events, kill, stdin and stderr.
      spawnImpl: () => child as ReturnType<typeof spawnProcess>,
      platform: 'win32',
      site: 'claude-proof-fixture',
      policy: (supervised) => claudeChildClosePolicy(supervised, closePlatform),
      acceptClose: claudeChildCloseProven
    }
  )
  managedChildren.set(child, managed)
  return managed
}
