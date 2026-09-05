import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_CHROME_DEVTOOLS_HANDLERS } from './agent-chrome-devtools'
import { configureChromeDevtools } from '../../main/agent-mcp/chrome-devtools-setup'
import type { HandlerContext } from '../dispatch'

vi.mock('../../main/agent-mcp/chrome-devtools-setup', () => ({ configureChromeDevtools: vi.fn() }))
vi.mock('../format', () => ({ printResult: vi.fn() }))
function context(entries: [string, string | boolean][] = []): HandlerContext {
  return {
    flags: new Map([['agent', 'all'], ...entries]),
    json: true,
    cwd: '/unused',
    get client(): never {
      throw new Error('Must not create an RPC client')
    }
  }
}
beforeEach(() => {
  vi.clearAllMocks()
  for (const key of ['ORCA_CLI_CWD', 'ORCA_ENVIRONMENT', 'ORCA_PAIRING_CODE']) {
    vi.stubEnv(key, '')
  }
})
afterEach(() => vi.unstubAllEnvs())
describe('agent chrome-devtools commands', () => {
  it('keeps setup explicit and dry-run/status read-only', async () => {
    await AGENT_CHROME_DEVTOOLS_HANDLERS['agent chrome-devtools setup'](context())
    expect(configureChromeDevtools).toHaveBeenLastCalledWith({ agent: 'all', apply: true })
    await AGENT_CHROME_DEVTOOLS_HANDLERS['agent chrome-devtools setup'](
      context([['dry-run', true]])
    )
    expect(configureChromeDevtools).toHaveBeenLastCalledWith({ agent: 'all', apply: false })
    await AGENT_CHROME_DEVTOOLS_HANDLERS['agent chrome-devtools status'](context())
    expect(configureChromeDevtools).toHaveBeenLastCalledWith({ agent: 'all', apply: false })
  })
  it.each(['host', 'environment', 'pairing-code'])(
    'rejects explicit remote selector --%s',
    async (key) => {
      await expect(
        AGENT_CHROME_DEVTOOLS_HANDLERS['agent chrome-devtools setup'](context([[key, 'remote']]))
      ).rejects.toThrow()
      expect(configureChromeDevtools).not.toHaveBeenCalled()
    }
  )
  it.each(['ORCA_CLI_CWD', 'ORCA_ENVIRONMENT', 'ORCA_PAIRING_CODE'])(
    'rejects ambiguous forwarded context %s',
    async (key) => {
      vi.stubEnv(key, 'remote')
      await expect(
        AGENT_CHROME_DEVTOOLS_HANDLERS['agent chrome-devtools setup'](context())
      ).rejects.toThrow('direct local invocation')
      expect(configureChromeDevtools).not.toHaveBeenCalled()
    }
  )
  it('requires a supported explicit agent selection', async () => {
    await expect(
      AGENT_CHROME_DEVTOOLS_HANDLERS['agent chrome-devtools setup'](context([['agent', 'claude']]))
    ).rejects.toThrow('Provide --agent')
  })
})
