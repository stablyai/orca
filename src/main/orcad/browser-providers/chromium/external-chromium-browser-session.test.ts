import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const runProcessMock = vi.fn<(spec: Spec) => Promise<unknown>>()
vi.mock('@orca/process-host', () => ({
  runProcess: (spec: Spec) => runProcessMock(spec)
}))
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => undefined),
  chmod: vi.fn(async () => undefined),
  readFile: vi.fn(async () => Buffer.from('')),
  realpath: vi.fn(async (path: string) => path),
  access: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined)
}))

import { ExternalChromiumBrowserSession } from './external-chromium-browser-session'
import { agentBrowserCommandOf } from '../../../browser/agent-browser/testing/agent-browser-bridge-test-harness'

const BASE = {
  executablePath: '/opt/orca/chromium',
  profilePath: '/state/browser-chromium',
  sessionName: 'orca-orcad-0123456789abcdef'
}

type Spec = {
  args?: readonly string[]
  input?: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
}

function commandOf(spec: Spec): string[] {
  return agentBrowserCommandOf(spec.args ?? [], spec.input)
}

describe('orcad external-chromium agent-browser environment', () => {
  beforeEach(() => {
    runProcessMock.mockReset()
    vi.mocked(mkdir).mockClear()
  })

  it('reports a ref whose element is gone as stale', async () => {
    runProcessMock.mockResolvedValue({
      code: 1,
      signal: null,
      stdout: JSON.stringify({
        success: false,
        error:
          'Stale ref for role=button name=Approve cannot be recovered: several elements now match.'
      }),
      stderr: '',
      timedOut: false
    })
    const session = new ExternalChromiumBrowserSession(
      '/opt/orca/agent-browser',
      { executablePath: BASE.executablePath, provider: 'chromium' },
      '/state'
    )
    await expect(session.run(['click', '@e2'])).rejects.toMatchObject({ code: 'browser_stale_ref' })
  })

  function startFailingOpen(error: string): Promise<string> {
    runProcessMock.mockImplementation((spec: Spec) =>
      Promise.resolve({
        code: 0,
        signal: null,
        stdout: JSON.stringify(
          commandOf(spec)[0] === 'open'
            ? { success: false, error }
            : { success: true, data: { tabs: [] } }
        ),
        stderr: '',
        timedOut: false
      })
    )
    return new ExternalChromiumBrowserSession(
      '/opt/orca/agent-browser',
      { executablePath: BASE.executablePath, provider: 'chromium' },
      '/state'
    ).start()
  }

  it('names the unwritable profile instead of the driver sandbox hint', async () => {
    const failure = startFailingOpen(
      'Chrome exited early (exit code: 21) without writing DevToolsActivePort\n' +
        'ERROR: Failed to create /state/browser-chromium/SingletonLock: Permission denied (13)\n' +
        'Failed to create a ProcessSingleton for your profile directory.\n' +
        'Hint: try --args "--no-sandbox"'
    )
    await expect(failure).rejects.toMatchObject({
      code: 'browser_unavailable',
      message: expect.stringContaining(join('/state', 'browser-chromium'))
    })
    await expect(failure).rejects.toMatchObject({
      message: expect.stringContaining('SingletonLock: Permission denied (13)')
    })
    await expect(failure).rejects.not.toMatchObject({
      message: expect.stringContaining('--no-sandbox')
    })
  })
})
