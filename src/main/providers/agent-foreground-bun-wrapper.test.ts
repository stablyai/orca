import { afterEach, expect, it } from 'vitest'
import { confirmShellForegroundProcess } from './agent-foreground-process'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform)
})

it('confirms a Windows Bun shell after its ownership gate is normalized away', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })

  await expect(
    confirmShellForegroundProcess(100, 'powershell.exe', {
      jobRootProcessIsWrapper: true,
      readWindowsPtyJobProcessIds: async () => new Set([200])
    })
  ).resolves.toBe(true)
})
