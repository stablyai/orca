import { expect, it, vi } from 'vitest'
import { PTY_CONSUMER_SESSION_PROTOCOL_VERSION } from '../../shared/pty-consumer-session'
import type { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import { resumeSshPtyConsumerSession } from './ssh-pty-consumer-session'

function fixture() {
  const controller = new AbortController()
  const grant = {
    protocolVersion: PTY_CONSUMER_SESSION_PROTOCOL_VERSION,
    serverBuildId: 'build',
    role: 'session-owner',
    clientGeneration: 3,
    ownerGeneration: 3,
    ownerLease: 'owner',
    resumed: true,
    capabilities: { outputFlowControl: { version: 1, windowSu: 256 } }
  }
  const request = vi.fn().mockResolvedValue(grant)
  const isDisposed = vi.fn(() => false)
  const mux = { request, isDisposed } as unknown as SshChannelMultiplexer
  const options = {
    clientInstanceId: 'client',
    expectedServerBuildId: 'build',
    resume: { ownerGeneration: 2, ownerLease: 'owner' },
    outputFlowControl: { requestedWindowSu: 512 },
    signal: controller.signal,
    assertAuthority: vi.fn()
  }
  const run = () => resumeSshPtyConsumerSession(mux, options)
  return { grant, request, isDisposed, mux, options, run, controller }
}

it('resumes through only the dedicated method and passes cancellation to transport', async () => {
  const f = fixture()
  await expect(f.run()).resolves.toEqual({
    resumed: true,
    state: {
      mode: 'negotiated',
      clientInstanceId: 'client',
      clientGeneration: 3,
      ownerGeneration: 3,
      ownerLease: 'owner',
      outputFlowControl: { version: 1, windowSu: 256 }
    }
  })
  expect(f.request).toHaveBeenCalledExactlyOnceWith(
    'pty.resumeClient',
    {
      protocolVersion: PTY_CONSUMER_SESSION_PROTOCOL_VERSION,
      clientInstanceId: 'client',
      requestedRole: 'session-owner',
      resume: { ownerGeneration: 2, ownerLease: 'owner' },
      capabilities: { outputFlowControl: { versions: [1], requestedWindowSu: 512 } }
    },
    { timeoutMs: 10_000, signal: f.controller.signal }
  )
  expect(f.options.assertAuthority).toHaveBeenCalledTimes(2)
})

it.each([-32601, -32000])(
  'never falls back on host error %s, even with legacy runtime option',
  async (code) => {
    const f = fixture()
    const error = Object.assign(new Error('host-refusal'), { code })
    f.request.mockRejectedValue(error)
    const options = { ...f.options, allowSameBuildLegacyFallback: true }
    await expect(resumeSshPtyConsumerSession(f.mux, options)).rejects.toBe(error)
    expect(f.request).toHaveBeenCalledOnce()
    expect(f.request.mock.calls[0][0]).toBe('pty.resumeClient')
  }
)

it.each([
  { ownerGeneration: 0 },
  { ownerGeneration: -1 },
  { ownerGeneration: 1.5 },
  { ownerGeneration: Number.MAX_SAFE_INTEGER + 1 },
  { ownerLease: '' },
  { ownerLease: 'x'.repeat(513) }
])('refuses invalid resume proof before RPC %j', async (proof) => {
  const f = fixture()
  Object.assign(f.options.resume, proof)
  await expect(f.run()).rejects.toThrow('resume_required')
  expect(f.request).not.toHaveBeenCalled()
})

it('refuses absent resume proof before RPC', async () => {
  const f = fixture()
  Reflect.deleteProperty(f.options, 'resume')
  await expect(f.run()).rejects.toThrow('resume_required')
  expect(f.request).not.toHaveBeenCalled()
})

it.each(['clientInstanceId', 'expectedServerBuildId'] as const)(
  'refuses missing %s before RPC',
  async (field) => {
    const f = fixture()
    f.options[field] = ''
    await expect(f.run()).rejects.toThrow('resume_required')
    expect(f.request).not.toHaveBeenCalled()
  }
)

it.each([
  { ownerLease: 'different' },
  { ownerGeneration: 2 },
  { ownerGeneration: 1 },
  { resumed: false },
  { resumed: undefined },
  { ownerGeneration: 0 },
  { clientGeneration: 0 },
  { serverBuildId: 'other' },
  { role: 'observer' },
  { capabilities: undefined }
])('refuses invalid or non-resumed grant %j', async (change) => {
  const f = fixture()
  Object.assign(f.grant, change)
  await expect(f.run()).rejects.toThrow()
  expect(f.request).toHaveBeenCalledOnce()
})

it.each(['before', 'after'] as const)('refuses lost native authority %s RPC', async (when) => {
  const f = fixture()
  const revoke = () =>
    f.options.assertAuthority.mockImplementation(() => {
      throw new Error('native-revoked')
    })
  if (when === 'before') {
    revoke()
  } else {
    f.request.mockImplementation(async () => {
      await Promise.resolve()
      revoke()
      return f.grant
    })
  }
  await expect(f.run()).rejects.toThrow('native-revoked')
  expect(f.request).toHaveBeenCalledTimes(when === 'before' ? 0 : 1)
})

it.each(['before', 'after'] as const)('refuses abort %s RPC', async (when) => {
  const f = fixture()
  if (when === 'before') {
    f.controller.abort(new Error('aborted'))
  } else {
    f.request.mockImplementation(async () => {
      await Promise.resolve()
      f.controller.abort(new Error('aborted'))
      return f.grant
    })
  }
  await expect(f.run()).rejects.toThrow('aborted')
  expect(f.request).toHaveBeenCalledTimes(when === 'before' ? 0 : 1)
})

it.each(['before', 'after'] as const)('refuses disposed mux %s RPC', async (when) => {
  const f = fixture()
  if (when === 'before') {
    f.isDisposed.mockReturnValue(true)
  } else {
    f.request.mockImplementation(async () => {
      await Promise.resolve()
      f.isDisposed.mockReturnValue(true)
      return f.grant
    })
  }
  await expect(f.run()).rejects.toThrow('transport_closed')
  expect(f.request).toHaveBeenCalledTimes(when === 'before' ? 0 : 1)
})

it('pins the original proof across await rather than accepting caller mutation', async () => {
  const f = fixture()
  f.request.mockImplementation(async () => {
    await Promise.resolve()
    f.options.resume.ownerLease = 'replacement'
    f.options.resume.ownerGeneration = 100
    return f.grant
  })
  await expect(f.run()).resolves.toMatchObject({
    resumed: true,
    state: { ownerLease: 'owner', ownerGeneration: 3 }
  })
  expect(f.request.mock.calls[0][1].resume).toEqual({ ownerLease: 'owner', ownerGeneration: 2 })
})
