import type { CreateOrAttachResult } from './types'
import type { PtySpawnResult } from '../providers/types'

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
