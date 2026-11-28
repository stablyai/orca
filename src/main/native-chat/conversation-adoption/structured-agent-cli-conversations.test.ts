import { expect, it } from 'vitest'
import { resumeInvocationFromOptions } from './structured-agent-cli-conversations'

const options = { targetless: ['-c', '--continue'], markers: ['-r', '--resume'] }

it('reads resume options only before the -- terminator', () => {
  expect(resumeInvocationFromOptions(['--', '--continue'], options)).toBeNull()
  expect(resumeInvocationFromOptions(['--', '--resume', 'abc'], options)).toBeNull()
  expect(resumeInvocationFromOptions(['--', '--resume=abc'], options)).toBeNull()
  expect(resumeInvocationFromOptions(['-r', 'abc', '--', '--continue'], options)).toEqual({
    target: 'abc'
  })
  expect(resumeInvocationFromOptions(['--continue', '--', 'fix it'], options)).toEqual({
    target: null
  })
})
