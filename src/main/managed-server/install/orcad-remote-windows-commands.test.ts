import type * as ExecCommandModule from '../../ssh/remote-exec/remote-exec-command'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../ssh/remote-exec/remote-exec-command', async (importOriginal) => ({
  ...(await importOriginal<typeof ExecCommandModule>()),
  execCommand: vi.fn()
}))
import { execCommand } from '../../ssh/remote-exec/remote-exec-command'
import {
  orcadWindowsNodeCommandLine,
  OrcadWindowsCommandLineError
} from './orcad-remote-windows-node'

const mockExec = vi.mocked(execCommand)

beforeEach(() => {
  mockExec.mockReset()
})

describe('Windows command lines for both DefaultShells', () => {
  it.each(['C:/Users/100%/x', 'C:/Users/$me/x', 'C:/Users/a`b/x'])(
    'refuses %s rather than letting a shell expand it',
    (value) => {
      expect(() => orcadWindowsNodeCommandLine('C:/rt/node.exe', [value])).toThrow(
        OrcadWindowsCommandLineError
      )
    }
  )
})
