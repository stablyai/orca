import { describe, expect, it } from 'vitest'
import { parseArgs } from '../../arguments/args'
import { getRepeatedStringFlag } from '../../arguments/flags'
import { ORCHESTRATION_WORKER_COMMAND_SPECS } from '../../specs/orchestration-worker-specs'

describe('worker-start --add-dir CLI parsing', () => {
  it('keeps every repeated --add-dir value in order', () => {
    const parsed = parseArgs(
      [
        'orchestration',
        'worker-start',
        '--spec',
        'work',
        '--add-dir',
        '/materials',
        '--add-dir',
        '/references'
      ],
      ORCHESTRATION_WORKER_COMMAND_SPECS.map((spec) => spec.path),
      ORCHESTRATION_WORKER_COMMAND_SPECS
    )
    expect(getRepeatedStringFlag(parsed.flags, 'add-dir')).toEqual(['/materials', '/references'])
  })
})
