import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))

vi.mock('child_process', () => ({ execFile: execFileMock }))

import { resetProcessTableSnapshotForTests } from '../../shared/process-table-snapshot'
import { resolveAgentForegroundProcess } from './agent-foreground-process'

describe('ZCode foreground process recognition', () => {
  let platform: PropertyDescriptor | undefined

  beforeEach(() => {
    resetProcessTableSnapshotForTests()
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'darwin' })
  })

  afterEach(() => {
    execFileMock.mockReset()
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('recognizes ZCode through its version-independent process tree', async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, callback: unknown) => {
        ;(callback as (error: unknown, result: { stdout: string; stderr: string }) => void)(null, {
          stdout: [
            '101 100 S    node /Users/dev/lib/node_modules/zcode-app-cli/bin/zcode.js --mode yolo',
            '102 101 S+   zcode-cli'
          ].join('\n'),
          stderr: ''
        })
      }
    )

    await expect(resolveAgentForegroundProcess(100, 'node')).resolves.toBe('zcode-cli')
  })
})
