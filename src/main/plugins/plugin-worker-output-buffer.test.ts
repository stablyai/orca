import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  PLUGIN_WORKER_OUTPUT_LINE_LIMIT,
  pipePluginWorkerOutput
} from './plugin-worker-output-buffer'

describe('pipePluginWorkerOutput', () => {
  it('bounds an unterminated line and resumes after its newline', () => {
    const stream = new PassThrough()
    const log = vi.fn()
    pipePluginWorkerOutput(stream, 'info', log)

    stream.write('x'.repeat(PLUGIN_WORKER_OUTPUT_LINE_LIMIT + 1_000))
    stream.write('discarded')
    expect(log).toHaveBeenCalledOnce()
    expect(log.mock.calls[0]?.[1]).toHaveLength(PLUGIN_WORKER_OUTPUT_LINE_LIMIT)

    stream.write('\nok\n')
    expect(log).toHaveBeenLastCalledWith('info', 'ok')
  })
})
