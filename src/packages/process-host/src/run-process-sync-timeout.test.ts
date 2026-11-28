import { expect, it } from 'vitest'
import { runProcessSync } from './run-process-sync'

it.skipIf(process.platform === 'win32')('stops a TERM-ignoring child at the sync timeout', () => {
  // Without SIGKILL, spawnSync blocks until the 2s sleep exits and reports no signal.
  const result = runProcessSync({
    program: '/bin/sh',
    args: ['-c', 'trap "" TERM; exec sleep 2'],
    timeoutMs: 200
  })
  expect(result).toMatchObject({ code: null, signal: 'SIGKILL', timedOut: true })
})
