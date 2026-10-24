import type { PipedChildProcess } from '@orca/process-host/process-spec'
import {
  spawnManagedProviderProcess,
  type ManagedProviderProcess
} from '../provider-process/managed-provider-process'
import { claudeChildClosePolicy, claudeChildCloseProven } from './claude-child-exit-proof-ladder'

const managedChildren = new WeakMap<object, ManagedProviderProcess>()

/** Fake handles keep the Windows owner isolated from real POSIX groups. */
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

/** Real children exercise the execution host's actual group owner. */
export function spawnRealClaudeProofChild(script: string): PipedChildProcess {
  const managed = spawnManagedProviderProcess(
    { command: process.execPath, args: ['-e', script] },
    {
      site: 'claude-proof-fixture',
      policy: claudeChildClosePolicy,
      acceptClose: claudeChildCloseProven
    }
  )
  managedChildren.set(managed.child, managed)
  return managed.child
}
