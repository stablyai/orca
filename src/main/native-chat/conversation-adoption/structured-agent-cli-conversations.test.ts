import { expect, it } from 'vitest'
import { resumeInvocationFromOptions } from './structured-agent-cli-conversations'

// Devin 3000.14.30821's own options: `-c/--continue` resumes the latest, `-r/--resume` an id.
const parse = (args: readonly string[]) =>
  resumeInvocationFromOptions(args, {
    targetless: ['-c', '--continue'],
    markers: ['-r', '--resume']
  })

it('reads a marker value whether it is detached, attached or equals-joined', () => {
  expect(parse(['--resume', 'blushing-entrance'])).toEqual({ target: 'blushing-entrance' })
  expect(parse(['--resume=blushing-entrance'])).toEqual({ target: 'blushing-entrance' })
  expect(parse(['-r', 'blushing-entrance'])).toEqual({ target: 'blushing-entrance' })
  // Verified against the CLI: both attached short forms parse as `-r <id>`.
  expect(parse(['-rblushing-entrance'])).toEqual({ target: 'blushing-entrance' })
  expect(parse(['-r=blushing-entrance'])).toEqual({ target: 'blushing-entrance' })
})

it('takes a marker with no value as the latest session', () => {
  expect(parse(['--resume'])).toEqual({ target: null })
  expect(parse(['-r'])).toEqual({ target: null })
  expect(parse(['-c'])).toEqual({ target: null })
  expect(parse(['--continue'])).toEqual({ target: null })
})

it('treats everything after the terminator as prompt text, not options', () => {
  expect(parse(['--', '-r', 'bug'])).toBeNull()
  expect(parse(['--', '--resume=bug'])).toBeNull()
  expect(parse(['--', '-c'])).toBeNull()
  expect(parse(['-r', 'blushing-entrance', '--', '-c', 'fix -r bug'])).toEqual({
    target: 'blushing-entrance'
  })
})

it('ignores options it does not know', () => {
  expect(parse([])).toBeNull()
  expect(parse(['--model', 'opus'])).toBeNull()
  expect(parse(['-p', 'fix the build'])).toBeNull()
})
