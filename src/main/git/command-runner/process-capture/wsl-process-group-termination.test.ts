import { expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import { createWslProcessGroupTermination } from './wsl-process-group-termination'

it.skipIf(process.platform === 'win32')(
  'proves normal guest-command completion with a marker from the guest wrapper',
  async () => {
    const termination = createWslProcessGroupTermination('fixture')
    let terminated = false
    const args = termination
      .wrapGuestArgs(['sh', '-c', 'printf output; printf diagnostic >&2'])
      .slice(1)
    const result = await runProcess({
      program: 'sh',
      args,
      terminationBarrier: termination,
      onChildTerminated: () => {
        terminated = true
      }
    })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('output')
    expect(termination.stripControlOutput(result.stderr)).toBe('diagnostic')
    expect(termination.isExitVerified?.()).toBe(true)
    expect(terminated).toBe(true)
  }
)

it.skipIf(process.platform === 'win32')(
  'does not treat a wrapper close without a guest completion marker as writer exit',
  async () => {
    const termination = createWslProcessGroupTermination('fixture')
    let terminated = false
    const result = await runProcess({
      program: 'sh',
      args: ['-c', 'exit 0'],
      terminationBarrier: termination,
      onChildTerminated: () => {
        terminated = true
      }
    })
    expect(result.code).toBe(0)
    expect(termination.isExitVerified?.()).toBe(false)
    expect(terminated).toBe(false)
  }
)
