import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir } from 'node:fs/promises'

const runProcessMock = vi.fn<(spec: Spec) => Promise<unknown>>()
vi.mock('@orca/process-host', () => ({
  runProcess: (spec: Spec) => runProcessMock(spec)
}))
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => undefined),
  readFile: vi.fn(async () => Buffer.from('')),
  rm: vi.fn(async () => undefined)
}))

import { ExternalChromiumBrowserSession } from './external-chromium-browser-session'

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

describe('orcad external-chromium agent-browser environment', () => {
  beforeEach(() => {
    runProcessMock.mockReset()
    vi.mocked(mkdir).mockClear()
  })

  it('does no work when startup is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const session = new ExternalChromiumBrowserSession(
      '/opt/orca/agent-browser',
      { executablePath: BASE.executablePath, provider: 'chromium' },
      '/state'
    )
    await expect(session.start(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(mkdir).not.toHaveBeenCalled()
    expect(runProcessMock).not.toHaveBeenCalled()
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
})
