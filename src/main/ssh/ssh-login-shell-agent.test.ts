import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import type { GlobalSettings } from '../../shared/global-settings-types'
import {
  applyLoginShellAgentSetting,
  bindLoginShellAgentSetting,
  resetLoginShellAgentForTests,
  waitForLoginShellAgent
} from './ssh-login-shell-agent'

const LAUNCH_SOCKET = '/tmp/launchd-agent/Listeners'

describe.skipIf(process.platform === 'win32')('login shell SSH agent', () => {
  let dir: string
  let shellSocket: string
  let server: Server

  beforeEach(async () => {
    vi.stubEnv('SSH_AUTH_SOCK', LAUNCH_SOCKET)
    dir = mkdtempSync(path.join(tmpdir(), 'login-agent-'))
    shellSocket = path.join(dir, 'agent.sock')
    server = createServer()
    await new Promise<void>((resolve) => server.listen(shellSocket, resolve))
  })

  afterEach(async () => {
    resetLoginShellAgentForTests()
    vi.unstubAllEnvs()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  })

  it('adopts the socket the login shell exports', async () => {
    await applyLoginShellAgentSetting(true, async () => ({ SSH_AUTH_SOCK: shellSocket }))
    expect(process.env.SSH_AUTH_SOCK).toBe(shellSocket)
  })

  it('keeps the launch socket when the shell exports something that is not a live socket', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const plainFile = path.join(dir, 'not-a-socket')
    writeFileSync(plainFile, '')

    await applyLoginShellAgentSetting(true, async () => ({ SSH_AUTH_SOCK: plainFile }))

    expect(process.env.SSH_AUTH_SOCK).toBe(LAUNCH_SOCKET)
    warn.mockRestore()
  })

  it('restores the launch socket when turned off', async () => {
    await applyLoginShellAgentSetting(true, async () => ({ SSH_AUTH_SOCK: shellSocket }))
    await applyLoginShellAgentSetting(false)
    expect(process.env.SSH_AUTH_SOCK).toBe(LAUNCH_SOCKET)
  })

  it('lets a later choice win over a slower earlier probe', async () => {
    let finishProbe: (env: NodeJS.ProcessEnv) => void = () => {}
    const probe = new Promise<NodeJS.ProcessEnv>((resolve) => {
      finishProbe = resolve
    })
    const enabling = applyLoginShellAgentSetting(true, () => probe)
    await applyLoginShellAgentSetting(false)
    finishProbe({ SSH_AUTH_SOCK: shellSocket })
    await enabling

    expect(process.env.SSH_AUTH_SOCK).toBe(LAUNCH_SOCKET)
  })

  it('holds connect attempts until an enabled probe has been applied', async () => {
    let finishProbe: (env: NodeJS.ProcessEnv) => void = () => {}
    void applyLoginShellAgentSetting(
      true,
      () =>
        new Promise((resolve) => {
          finishProbe = resolve
        })
    )
    let ready = false
    const waiting = waitForLoginShellAgent().then(() => {
      ready = true
    })
    await Promise.resolve()
    expect(ready).toBe(false)

    finishProbe({ SSH_AUTH_SOCK: shellSocket })
    await waiting
    expect(process.env.SSH_AUTH_SOCK).toBe(shellSocket)
  })

  it('reacts only to its own setting and rebinds without duplicate listeners', () => {
    const listeners = new Set<
      (updates: Partial<GlobalSettings>, settings: GlobalSettings) => void
    >()
    const store = {
      getSettings: () => ({ sshUseLoginShellAgent: false }),
      onSettingsChanged: (
        listener: (updates: Partial<GlobalSettings>, settings: GlobalSettings) => void
      ) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    }

    bindLoginShellAgentSetting(store)
    bindLoginShellAgentSetting(store)

    expect(listeners.size).toBe(1)
  })
})
