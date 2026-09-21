import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAutomationPrecheck } from './precheck-runner'

const sshManagerState = vi.hoisted(() => ({
  manager: null as null | {
    getConnection: ReturnType<typeof vi.fn>
  }
}))

vi.mock('../ipc/ssh', () => ({
  getSshConnectionManager: () => sshManagerState.manager
}))

const node = JSON.stringify(process.execPath)

function nodeCommand(script: string): string {
  return `${node} -e ${JSON.stringify(script)}`
}

describe('runAutomationPrecheck', () => {
  let cwd = ''

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'orca-precheck-test-'))
    sshManagerState.manager = null
  })

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  it('captures exit code and output for a non-zero local precheck', async () => {
    const result = await runAutomationPrecheck({
      precheck: {
        command: nodeCommand(
          "console.log('stdout text'); console.error('stderr text'); process.exit(7)"
        ),
        timeoutSeconds: 5
      },
      target: { type: 'local', cwd }
    })

    expect(result.exitCode).toBe(7)
    expect(result.timedOut).toBe(false)
    expect(result.stdout).toContain('stdout text')
    expect(result.stderr).toContain('stderr text')
    expect(result.error).toBeNull()
  })

  it('adds run identity to the local precheck environment', async () => {
    const result = await runAutomationPrecheck({
      precheck: {
        command: nodeCommand('process.stdout.write(String(process.env.ORCA_AUTOMATION_RUN_ID))'),
        timeoutSeconds: 5
      },
      target: { type: 'local', cwd },
      env: { ORCA_AUTOMATION_RUN_ID: 'run-7' }
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('run-7')
  })

  it('marks a local precheck as timed out', async () => {
    const result = await runAutomationPrecheck({
      precheck: {
        command: nodeCommand('setTimeout(() => {}, 5000)'),
        timeoutSeconds: 1
      },
      target: { type: 'local', cwd }
    })

    expect(result.exitCode).toBeNull()
    expect(result.timedOut).toBe(true)
    expect(result.error).toBe('Precheck timed out after 1s.')
  })

  // A precheck is a whole shell line, so the identity has to be exported before it, not
  // prefixed onto it as a `VAR=value command` assignment.
  it('exports run identity ahead of the SSH precheck command', async () => {
    const channel = Object.assign(new EventEmitter(), {
      stderr: new PassThrough(),
      close: vi.fn()
    })
    const exec = vi.fn(async () => channel)
    sshManagerState.manager = {
      getConnection: vi.fn(() => ({
        getState: () => ({ status: 'connected' }),
        exec
      }))
    }

    const resultPromise = runAutomationPrecheck({
      precheck: { command: "printf 'ready'", timeoutSeconds: 5 },
      target: { type: 'ssh', cwd: '/repo/path', connectionId: 'ssh-1' },
      env: { ORCA_AUTOMATION_ID: 'automation-1', ORCA_AUTOMATION_NAME: "Andy's triage" }
    })
    await Promise.resolve()
    channel.emit('exit', 0)
    channel.emit('close')
    await resultPromise

    expect(exec).toHaveBeenCalledWith(
      "export ORCA_AUTOMATION_ID='automation-1' ORCA_AUTOMATION_NAME='Andy'\\''s triage'; " +
        "cd '/repo/path' && printf 'ready'"
    )
  })

  it('uses the SSH channel exit event as the precheck exit code', async () => {
    const channel = Object.assign(new EventEmitter(), {
      stderr: new PassThrough(),
      close: vi.fn()
    })
    sshManagerState.manager = {
      getConnection: vi.fn(() => ({
        getState: () => ({ status: 'connected' }),
        exec: vi.fn(async () => channel)
      }))
    }

    const resultPromise = runAutomationPrecheck({
      precheck: {
        command: "printf 'ready'",
        timeoutSeconds: 5
      },
      target: {
        type: 'ssh',
        cwd: '/repo/path',
        connectionId: 'ssh-1'
      }
    })
    await Promise.resolve()
    channel.emit('data', Buffer.from('ready\n'))
    channel.emit('exit', 0)
    channel.emit('close')

    const result = await resultPromise
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('ready')
    expect(result.error).toBeNull()
  })
})
