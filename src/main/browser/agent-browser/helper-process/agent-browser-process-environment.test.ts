import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createAgentBrowserProcessEnvironment,
  pointAtEmptyAgentBrowserConfig
} from './agent-browser-process-environment'

describe('desktop agent-browser helper environment', () => {
  let userDataPath: string | undefined

  afterEach(() => {
    if (userDataPath) {
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('drops the user agent-browser settings and points config at an empty Orca file', async () => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-ab-env-'))
    const { env } = createAgentBrowserProcessEnvironment({
      inheritedEnv: {
        PATH: '/usr/bin',
        AGENT_BROWSER_PIN_TAB: '1',
        agent_browser_auto_connect: '1',
        AGENT_BROWSER_CDP: 'ws://127.0.0.1:9222/devtools/browser/user',
        AGENT_BROWSER_CONFIG: '/home/user/agent-browser.json',
        AGENT_BROWSER_SOCKET_DIR: '/tmp/ab-sockets',
        AGENT_BROWSER_NAMESPACE: 'work',
        AGENT_BROWSER_IDLE_TIMEOUT_MS: '5000'
      },
      platform: 'darwin',
      userDataPath
    })
    await pointAtEmptyAgentBrowserConfig(env, userDataPath)

    expect(env).toEqual({
      PATH: '/usr/bin',
      AGENT_BROWSER_SOCKET_DIR: '/tmp/ab-sockets',
      AGENT_BROWSER_IDLE_TIMEOUT_MS: '5000',
      AGENT_BROWSER_NO_AUTO_DIALOG: '1',
      AGENT_BROWSER_CONFIG: join(userDataPath, 'agent-browser-config.json')
    })
    expect(
      JSON.parse(readFileSync(join(userDataPath, 'agent-browser-config.json'), 'utf8'))
    ).toEqual({})
  })
})
