import './mock-descendant-sweep'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockPtySpawn, mockPtyInstance, mockCreateShellPromptReadinessProbe } = vi.hoisted(() => ({
  mockPtySpawn: vi.fn(),
  mockCreateShellPromptReadinessProbe: vi.fn(),
  mockPtyInstance: {
    pid: process.pid,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    clear: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn()
  }
}))

vi.mock('node-pty', () => ({
  spawn: mockPtySpawn
}))

vi.mock('../main/pty/posix-pty-process-groups', () => ({
  forceKillPosixPtyProcessGroups: vi.fn((_pid: number, fallback: () => void) => fallback())
}))

vi.mock('../main/shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: mockCreateShellPromptReadinessProbe
}))

import type { PtyHandler } from './pty-handler'
import { beginPtyHandlerTest, endPtyHandlerTest } from './pty-handler-test-harness'
import type { MockDispatcher } from './pty-handler-test-harness'

const describePosix = process.platform === 'win32' ? describe.skip : describe

describePosix('relay startup command staging', () => {
  let dispatcher: MockDispatcher
  let handler: PtyHandler
  let originalPlatform: PropertyDescriptor | undefined
  let stagingDir: string

  beforeEach(() => {
    stagingDir = mkdtempSync(join(tmpdir(), 'orca-relay-staging-'))
    vi.stubEnv('TMPDIR', stagingDir)
    ;({ dispatcher, handler, originalPlatform } = beginPtyHandlerTest({
      mockPtySpawn,
      mockPtyInstance,
      mockCreateShellPromptReadinessProbe
    }))
  })

  afterEach(async () => {
    await endPtyHandlerTest(handler, originalPlatform)
    vi.unstubAllEnvs()
    rmSync(stagingDir, { recursive: true, force: true })
  })

  async function spawn(command: string): Promise<unknown> {
    return await dispatcher.callRequest('pty.spawn', {
      command,
      commandDelivery: 'provider',
      env: { SHELL: '/bin/zsh' }
    })
  }

  it('types a short provider-delivered command as is', async () => {
    await spawn('echo short')
    await vi.advanceTimersByTimeAsync(50)
    expect(mockPtySpawn.mock.results[0]?.value.write).toHaveBeenCalledWith('echo short\r')
  })

  it('stages a long provider-delivered command and types only the sourcing line', async () => {
    const command = `claude '${'x'.repeat(600)}'`
    await spawn(command)
    const [script] = readdirSync(stagingDir)
    const scriptPath = join(stagingDir, script)
    expect(readFileSync(scriptPath, 'utf8').split('\n')[1]).toBe(command)
    await vi.advanceTimersByTimeAsync(50)
    expect(mockPtySpawn.mock.results[0]?.value.write).toHaveBeenCalledWith(`. '${scriptPath}'\r`)
  })

  it('deletes a script the shell never sourced when the PTY exits', async () => {
    await spawn(`claude '${'x'.repeat(600)}'`)
    const scriptPath = join(stagingDir, readdirSync(stagingDir)[0])
    mockPtyInstance.onExit.mock.calls.at(-1)?.[0]?.({ exitCode: 0 })
    expect(existsSync(scriptPath)).toBe(false)
  })

  it('stages nothing for a renderer-delivered command it only holds as a hint', async () => {
    await dispatcher.callRequest('pty.spawn', {
      command: `claude '${'x'.repeat(600)}'`,
      env: { SHELL: '/bin/zsh' }
    })
    expect(readdirSync(stagingDir)).toEqual([])
  })

  it('prints a notice in the terminal when it types a line it could not stage', async () => {
    vi.stubEnv('TMPDIR', join(stagingDir, 'missing'))
    const command = `claude '${'x'.repeat(600)}'`
    await spawn(command)
    await vi.advanceTimersByTimeAsync(50)
    expect(mockPtySpawn.mock.results[0]?.value.write).toHaveBeenCalledWith(`${command}\r`)
    const output = dispatcher._notifications
      .filter((notification) => notification.method === 'pty.data')
      .map((notification) => String(notification.params?.data))
      .join('')
    expect(output).toContain('[orca] Could not stage the launch command (ENOENT')
  })
})
