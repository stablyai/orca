import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { createAgentBrowserProcessEnvironment } from './agent-browser-process-environment'

describe('createAgentBrowserProcessEnvironment', () => {
  it('drops an inherited AGENT_BROWSER_CDP so only Orca names the CDP target', () => {
    const { env } = createAgentBrowserProcessEnvironment({
      inheritedEnv: { AGENT_BROWSER_CDP: '9222', PATH: '/bin' },
      platform: 'win32',
      userDataPath: '/user-data'
    })
    expect(env.AGENT_BROWSER_CDP).toBeUndefined()
    expect(env.PATH).toBe('/bin')
  })
})

describe('bundled agent-browser', () => {
  it('reads AGENT_BROWSER_CDP, which carries the tokened proxy URL', () => {
    // agent-browser 0.30 and older ignore AGENT_BROWSER_CDP and would launch their own Chrome.
    const require = createRequire(import.meta.url)
    const { version }: { version: string } = JSON.parse(
      readFileSync(require.resolve('agent-browser/package.json'), 'utf8')
    )
    const [major, minor] = version.split('.').map(Number)
    expect(major > 0 || minor >= 35, `agent-browser ${version}`).toBe(true)
  })
})
