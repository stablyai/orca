import { expect, it } from 'vitest'
import { describeProcessFailure } from './script-child-process.mjs'

it('names a timeout and both streams when stderr is empty', () => {
  expect(
    describeProcessFailure({
      code: null,
      signal: 'SIGTERM',
      stdout: '{"type":"orca_profile_state_ready"}\r\n',
      stderr: '',
      timedOut: true,
      outputTruncated: false
    })
  ).toBe('code=none signal=SIGTERM timed out\nstdout:\n{"type":"orca_profile_state_ready"}')
})

it('keeps the tail of long output', () => {
  const failure = describeProcessFailure({
    code: 1,
    signal: null,
    stdout: '',
    stderr: `${'x'.repeat(5000)}END`,
    timedOut: false,
    outputTruncated: true
  })
  expect(failure.startsWith('code=1 signal=none output truncated\nstderr:\n')).toBe(true)
  expect(failure.endsWith('END')).toBe(true)
  expect(failure.length).toBeLessThan(4100)
})
