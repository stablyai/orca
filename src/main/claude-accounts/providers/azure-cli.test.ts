import { describe, expect, it, vi, beforeEach } from 'vitest'
import { detectAzureEntraIdSignIn } from './azure-cli'

const spawnMock = vi.fn()
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args)
}))

function fakeProcess(
  exitCode: number,
  stdout = '',
  stderr = ''
): { mock: unknown; close: () => void } {
  const listeners: Record<string, Array<(arg?: unknown) => void>> = {}
  const proc = {
    stdout: {
      on: (e: string, cb: (b: Buffer) => void) => {
        listeners[`stdout:${e}`] = [...(listeners[`stdout:${e}`] ?? []), cb]
      }
    },
    stderr: {
      on: (e: string, cb: (b: Buffer) => void) => {
        listeners[`stderr:${e}`] = [...(listeners[`stderr:${e}`] ?? []), cb]
      }
    },
    on: (e: string, cb: (arg?: unknown) => void) => {
      listeners[e] = [...(listeners[e] ?? []), cb]
    }
  }
  return {
    mock: proc,
    close: () => {
      ;(listeners['stdout:data'] ?? []).forEach((cb) => cb(Buffer.from(stdout)))
      ;(listeners['stderr:data'] ?? []).forEach((cb) => cb(Buffer.from(stderr)))
      ;(listeners['close'] ?? []).forEach((cb) => cb(exitCode))
    }
  }
}

describe('detectAzureEntraIdSignIn', () => {
  beforeEach(() => spawnMock.mockReset())

  it('returns { ok: true, account } on `az account show` exit 0 with valid JSON', async () => {
    const { mock, close } = fakeProcess(
      0,
      JSON.stringify({ user: { name: 'alice@x.com' }, tenantId: 't1' })
    )
    spawnMock.mockReturnValue(mock)
    const promise = detectAzureEntraIdSignIn()
    close()
    const result = await promise
    if (!result.ok) throw new Error('expected ok')
    expect(result.account.user).toBe('alice@x.com')
    expect(result.account.tenantId).toBe('t1')
  })

  it('returns { ok: false, reason: "not-logged-in" } on non-zero exit', async () => {
    const { mock, close } = fakeProcess(1, '', 'Please run az login')
    spawnMock.mockReturnValue(mock)
    const promise = detectAzureEntraIdSignIn()
    close()
    const result = await promise
    if (result.ok) throw new Error('expected fail')
    expect(result.reason).toBe('not-logged-in')
  })

  it('returns { ok: false, reason: "az-not-installed" } when spawn throws ENOENT', async () => {
    spawnMock.mockImplementationOnce(() => {
      throw Object.assign(new Error('not found'), { code: 'ENOENT' })
    })
    const result = await detectAzureEntraIdSignIn()
    if (result.ok) throw new Error('expected fail')
    expect(result.reason).toBe('az-not-installed')
  })

  it('returns { ok: false, reason: "malformed-output" } on exit 0 with non-JSON stdout', async () => {
    const { mock, close } = fakeProcess(0, 'not json')
    spawnMock.mockReturnValue(mock)
    const promise = detectAzureEntraIdSignIn()
    close()
    const result = await promise
    if (result.ok) throw new Error('expected fail')
    expect(result.reason).toBe('malformed-output')
  })
})
