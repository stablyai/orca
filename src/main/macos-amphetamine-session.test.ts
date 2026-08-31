import { describe, expect, it, vi } from 'vitest'
import {
  AMPHETAMINE_SESSION_STATUS_SCRIPT,
  classifyAmphetamineFailure,
  detectAmphetamineInstalled,
  parseAmphetamineSessionStatus,
  type OsascriptResult
} from './macos-amphetamine-session'

function ok(stdout = ''): OsascriptResult {
  return { code: 0, stdout, stderr: '', timedOut: false }
}

function failure(stderr: string, code = 1): OsascriptResult {
  return { code, stdout: '', stderr, timedOut: false }
}

describe('Amphetamine session status script', () => {
  it('only reads session state and never launches the app to do so', () => {
    expect(AMPHETAMINE_SESSION_STATUS_SCRIPT).toContain('is running')
    expect(AMPHETAMINE_SESSION_STATUS_SCRIPT).toContain('session is active')
    for (const write of [
      'start new session',
      'end session',
      'allow display sleep',
      'prevent display sleep',
      'enable closed display mode'
    ]) {
      expect(AMPHETAMINE_SESSION_STATUS_SCRIPT).not.toContain(write)
    }
  })
})

describe('Amphetamine session status parsing', () => {
  it.each([
    ['active', 'active'],
    ['inactive\n', 'inactive']
  ])('parses %s', (stdout, expected) => {
    expect(parseAmphetamineSessionStatus(stdout)).toBe(expected)
  })

  it.each(['', 'started', 'foreign', 'true'])('rejects unrecognized output %s', (stdout) => {
    expect(parseAmphetamineSessionStatus(stdout)).toBeNull()
  })
})

describe('detectAmphetamineInstalled', () => {
  it('reports installed when Launch Services resolves the bundle', async () => {
    const run = vi.fn(async () => ok('/Applications/Amphetamine.app\n'))
    await expect(detectAmphetamineInstalled(run, 'darwin')).resolves.toBe(true)
  })

  it('forwards cancellation to the Launch Services lookup', async () => {
    const abort = new AbortController()
    const run = vi.fn(async (_script: string, signal?: AbortSignal) => {
      expect(signal).toBe(abort.signal)
      return ok('/Applications/Amphetamine.app\n')
    })

    await expect(detectAmphetamineInstalled(run, 'darwin', abort.signal)).resolves.toBe(true)
  })

  it('reports not installed only when Launch Services says so', async () => {
    const run = vi.fn(async () => failure('execution error: ... (-1728)'))
    await expect(detectAmphetamineInstalled(run, 'darwin')).resolves.toBe(false)
  })

  it.each([
    ['a transient error', failure('some other problem')],
    ['a timeout', { code: null, stdout: '', stderr: '', timedOut: true }],
    [
      'a timeout with partial success output',
      {
        code: 0,
        stdout: '/Applications/Amphetamine.app',
        stderr: '',
        timedOut: true
      }
    ]
  ])('reports unknown for %s rather than not-installed', async (_label, result) => {
    const run = vi.fn(async () => result as OsascriptResult)
    await expect(detectAmphetamineInstalled(run, 'darwin')).resolves.toBeUndefined()
  })

  it('reports unknown when the probe cannot be spawned', async () => {
    const run = vi.fn(async () => {
      throw new Error('spawn failed')
    })
    await expect(detectAmphetamineInstalled(run, 'darwin')).resolves.toBeUndefined()
  })

  it('never probes off macOS', async () => {
    const run = vi.fn(async () => ok('/Applications/Amphetamine.app'))
    await expect(detectAmphetamineInstalled(run, 'linux')).resolves.toBe(false)
    expect(run).not.toHaveBeenCalled()
  })
})

describe('classifyAmphetamineFailure', () => {
  it('reads a missing bundle as not-installed', () => {
    expect(classifyAmphetamineFailure(failure('execution error: (-1728)'))).toBe('not-installed')
  })

  it('reads a refused Apple event as automation-denied', () => {
    expect(
      classifyAmphetamineFailure(failure('Not authorized to send Apple events to Amphetamine.'))
    ).toBe('automation-denied')
  })

  it('leaves transient failures unclassified so they retry', () => {
    expect(classifyAmphetamineFailure(failure('some other problem'))).toBeNull()
  })
})
