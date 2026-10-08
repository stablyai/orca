import type { DurableProfileStateMutation, StoreRuntimeState } from './store-runtime-state'
import {
  flushDurableStateOrThrowAsync,
  type WriteFlushBarrierOperations
} from './write-flush-barriers'

export type SshLeaseDurableMutationRuntime = Pick<
  StoreRuntimeState,
  | 'dirtyProfileStateDomains'
  | 'profileMaintenancePending'
  | 'profileStateAuthority'
  | 'quitFlushStarted'
  | 'runDurableMutation'
  | 'writesFrozen'
>

export async function runSshLeaseDurableMutation<T>(
  runtime: SshLeaseDurableMutationRuntime,
  barriers: WriteFlushBarrierOperations,
  domain: 'sshPtyConsumerRecoveries' | 'sshRemotePtyLeases',
  mutate: () => DurableProfileStateMutation<T>
): Promise<T> {
  const writeMutation = (): DurableProfileStateMutation<T> => {
    const mutation = mutate()
    if (mutation.persist !== false) {
      runtime.dirtyProfileStateDomains?.add(domain)
    }
    return mutation
  }
  if (runtime.profileStateAuthority?.asynchronous) {
    return runtime.runDurableMutation(writeMutation)
  }
  if (runtime.writesFrozen || runtime.quitFlushStarted || runtime.profileMaintenancePending) {
    throw new Error('Cannot mutate finalized profile persistence')
  }
  // Legacy SSH recovery keeps its existing asynchronous disk barrier on older runtimes.
  const mutation = writeMutation()
  if (mutation.persist !== false) {
    await flushDurableStateOrThrowAsync(barriers)
  }
  return mutation.value
}
