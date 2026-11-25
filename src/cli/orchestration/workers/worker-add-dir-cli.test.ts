import { describe, expect, it } from 'vitest'
import { parseArgs } from '../../arguments/args'
import { getRepeatedStringFlag } from '../../arguments/flags'
import { ORCHESTRATION_WORKER_COMMAND_SPECS } from '../../specs/orchestration-worker-specs'
import { ORCHESTRATION_WORKER_ADDITIONAL_DIRECTORIES_RUNTIME_CAPABILITY } from '../../../shared/orchestration/orchestration-runtime-capabilities'
import { ORCHESTRATION_WORKER_LAUNCH_HANDLER } from './worker-launch-handler'

describe('worker-start --add-dir CLI parsing and cwd resolution', () => {
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

  it('resolves relative --add-dir against CLI cwd and rejects relative --add-dir with --on', async () => {
    const sent: unknown[] = []
    const client = {
      call: async (method: string, params: unknown) => {
        if (method === 'status.get') {
          return {
            result: {
              capabilities: [ORCHESTRATION_WORKER_ADDITIONAL_DIRECTORIES_RUNTIME_CAPABILITY]
            }
          }
        }
        if (method === 'orchestration.workerStart') {
          sent.push(params)
          return { result: { state: 'ready', dispatchId: 'disp_1' } }
        }
        return { result: {} }
      }
    }

    const parsedLocal = parseArgs(
      [
        'orchestration',
        'worker-start',
        '--spec',
        'work',
        '--from',
        'term_coord',
        '--add-dir',
        '../materials',
        '--add-dir',
        '/abs/dir',
        '--json'
      ],
      ORCHESTRATION_WORKER_COMMAND_SPECS.map((spec) => spec.path),
      ORCHESTRATION_WORKER_COMMAND_SPECS
    )
    await ORCHESTRATION_WORKER_LAUNCH_HANDLER['orchestration worker-start']({
      flags: parsedLocal.flags,
      client,
      cwd: '/workspace/project',
      json: true
    } as unknown as Parameters<
      (typeof ORCHESTRATION_WORKER_LAUNCH_HANDLER)['orchestration worker-start']
    >[0])

    expect(sent).toHaveLength(1)
    expect((sent[0] as { additionalDirectories?: string[] }).additionalDirectories).toEqual([
      '/workspace/materials',
      '/abs/dir'
    ])

    const parsedRemote = parseArgs(
      [
        'orchestration',
        'worker-start',
        '--spec',
        'work',
        '--on',
        'remote-box',
        '--add-dir',
        '../materials'
      ],
      ORCHESTRATION_WORKER_COMMAND_SPECS.map((spec) => spec.path),
      ORCHESTRATION_WORKER_COMMAND_SPECS
    )
    await expect(
      ORCHESTRATION_WORKER_LAUNCH_HANDLER['orchestration worker-start']({
        flags: parsedRemote.flags,
        client,
        cwd: '/workspace/project',
        json: true
      } as unknown as Parameters<
        (typeof ORCHESTRATION_WORKER_LAUNCH_HANDLER)['orchestration worker-start']
      >[0])
    ).rejects.toThrow(/--on/)
  })
})
