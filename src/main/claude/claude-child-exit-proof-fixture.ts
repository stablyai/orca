import type { EventEmitter } from 'node:events'
import type { spawnProcess, SpawnedProcess } from '../../shared/child-process/run-process'
import {
  spawnManagedProviderProcess,
  type ManagedProviderProcess
} from '../provider-process/managed-provider-process'
import { claudeChildClosePolicy } from './claude-child-exit-proof-ladder'

const managedChildren = new WeakMap<object, ManagedProviderProcess>()

export function managedChild(
  child: Pick<SpawnedProcess, 'pid' | 'kill' | 'stdin' | 'stderr'> & EventEmitter
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
      policy: claudeChildClosePolicy,
      acceptClose: (result) => result.root === 'exited' && result.tree === 'exited'
    }
  )
  managedChildren.set(child, managed)
  return managed
}
