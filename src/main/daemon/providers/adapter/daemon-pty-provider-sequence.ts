import type { DaemonCreateOrAttachResult as CreateOrAttachResult } from '../../protocol/daemon-create-or-attach-result'
import type { PtySpawnResult } from '../../../providers/pty/spawn-result'

export function providerSequenceFromCreateOrAttach(
  result: CreateOrAttachResult
): PtySpawnResult['providerSequence'] {
  if (result.isNew) {
    return { value: 0, generation: 'reset' }
  }
  return typeof result.snapshot?.outputSequence === 'number'
    ? { value: result.snapshot.outputSequence, generation: 'continued' }
    : undefined
}
