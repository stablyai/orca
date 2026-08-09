import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnection } from '../ssh/ssh-connection'
import { resolveRemoteJsDebugEntrypoint } from './js-debug-remote-bundle'

const { execCommandMock } = vi.hoisted(() => ({ execCommandMock: vi.fn() }))
vi.mock('../ssh/ssh-relay-exec-command', () => ({ execCommand: execCommandMock }))

const FAKE_CONNECTION = {} as SshConnection

describe('resolveRemoteJsDebugEntrypoint', () => {
  beforeEach(() => {
    execCommandMock.mockReset()
  })

  it('returns the entrypoint path when the remote bundle is staged', async () => {
    execCommandMock.mockResolvedValueOnce('/home/dev\n').mockResolvedValueOnce('present\n')
    const entrypoint = await resolveRemoteJsDebugEntrypoint(FAKE_CONNECTION)
    expect(entrypoint).toBe('/home/dev/.orca/debug-adapters/js-debug/src/dapDebugServer.js')
  })

  it('throws a clear, actionable error when the bundle is not staged', async () => {
    execCommandMock.mockResolvedValueOnce('/home/dev\n').mockResolvedValueOnce('missing\n')
    await expect(resolveRemoteJsDebugEntrypoint(FAKE_CONNECTION)).rejects.toThrow(
      /not staged on the remote host/
    )
  })

  it('throws when the remote $HOME cannot be resolved', async () => {
    execCommandMock.mockResolvedValueOnce('\n')
    await expect(resolveRemoteJsDebugEntrypoint(FAKE_CONNECTION)).rejects.toThrow(
      /Could not resolve the remote home directory/
    )
  })

  it('shell-escapes the entrypoint path in the probe command, even if $HOME contains a single quote', async () => {
    execCommandMock.mockResolvedValueOnce("/home/o'brien\n").mockResolvedValueOnce('present\n')
    await resolveRemoteJsDebugEntrypoint(FAKE_CONNECTION)
    const probeCommand = execCommandMock.mock.calls[1]?.[1] as string
    expect(probeCommand).toContain(
      String.raw`'/home/o'\''brien/.orca/debug-adapters/js-debug/src/dapDebugServer.js'`
    )
  })
})
