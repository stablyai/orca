import { afterEach, describe, expect, it } from 'vitest'
import { confirmShellForegroundProcess } from './agent-foreground-process'

const realPlatform = process.platform
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform })
})

describe('Windows shell confirmation with a rejecting job reader', () => {
  it('fails closed instead of rejecting the confirmation', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    // A rejecting reader is missing proof, never a thrown confirmation.
    await expect(
      confirmShellForegroundProcess(100, 'powershell.exe', {
        readWindowsPtyJobProcessIds: async () => {
          throw new Error('job handle gone')
        }
      })
    ).resolves.toBe(false)
  })
})
