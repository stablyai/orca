import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFsModule from 'node:fs'
import type * as NodeOsModule from 'node:os'
import type * as WslTranscriptFsAccessModule from './wsl-transcript-fs-access'

const CONVERSATION_ID = '4c45c752-d568-475a-9a04-973901abee4c'
const TRANSCRIPT_TAIL = `.gemini\\antigravity-cli\\brain\\${CONVERSATION_ID}\\.system_generated\\logs\\transcript.jsonl`
const UBUNTU_TRANSCRIPT = `\\\\wsl.localhost\\Ubuntu\\home\\ada\\${TRANSCRIPT_TAIL}`
const DEBIAN_TRANSCRIPT = `\\\\wsl.localhost\\Debian\\home\\ada\\${TRANSCRIPT_TAIL}`

const mocks = vi.hoisted(() => ({
  hostExisting: new Set<string>(),
  // UNC path → true (readable), or 'stall' for a gate refusal. Absent means missing.
  wslFiles: new Map<string, true | 'stall'>(),
  existsSync: vi.fn(),
  wslGatedAccess: vi.fn()
}))

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOsModule>()),
  homedir: () => 'C:\\Users\\ada'
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsModule>()
  mocks.existsSync.mockImplementation((path: string) =>
    [...mocks.hostExisting].some((hostPath) => path === hostPath)
  )
  return { ...actual, existsSync: mocks.existsSync }
})
vi.mock('./wsl-transcript-fs-access', async (importOriginal) => {
  const { wslTranscriptFsTimeoutError } = await import('./wsl-transcript-fs-error')
  mocks.wslGatedAccess.mockImplementation(async (path: string) => {
    const entry = mocks.wslFiles.get(path)
    if (entry === 'stall') {
      throw wslTranscriptFsTimeoutError()
    }
    return entry === true
  })
  return {
    ...(await importOriginal<typeof WslTranscriptFsAccessModule>()),
    wslGatedAccess: mocks.wslGatedAccess
  }
})
vi.mock('../wsl', () => ({
  listRunningWslDistrosAsync: vi.fn(async () => ['Ubuntu', 'Debian']),
  listRunningWslHomeDirsAsync: vi.fn(async () => [
    '\\\\wsl.localhost\\Ubuntu\\home\\ada',
    '\\\\wsl.localhost\\Debian\\home\\ada'
  ]),
  getWslHomeAsync: vi.fn(async (distro: string) => `\\\\wsl.localhost\\${distro}\\home\\ada`)
}))

import { join } from 'node:path'
import { resolveSessionFilePath } from './session-file-resolver'
import { resetHostReadableTranscriptPathCacheForTests } from './host-readable-transcript-path'
import { WslTranscriptFsError } from './wsl-transcript-fs-error'
import { listRunningWslDistrosAsync, listRunningWslHomeDirsAsync } from '../wsl'

const HOST_TRANSCRIPT = join(
  'C:\\Users\\ada',
  '.gemini',
  'antigravity-cli',
  'brain',
  CONVERSATION_ID,
  '.system_generated',
  'logs',
  'transcript.jsonl'
)

const realPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

beforeEach(() => {
  resetHostReadableTranscriptPathCacheForTests()
  mocks.hostExisting.clear()
  mocks.wslFiles.clear()
  mocks.existsSync.mockClear()
  mocks.wslGatedAccess.mockClear()
  vi.mocked(listRunningWslDistrosAsync).mockClear()
  vi.mocked(listRunningWslHomeDirsAsync).mockClear()
  setPlatform('win32')
})

afterEach(() => setPlatform(realPlatform))

describe('Antigravity id-based resolve on a Windows host with WSL', () => {
  it('finds a WSL guest transcript when the host brain has no such conversation', async () => {
    mocks.wslFiles.set(UBUNTU_TRANSCRIPT, true)

    await expect(resolveSessionFilePath('antigravity', CONVERSATION_ID)).resolves.toBe(
      UBUNTU_TRANSCRIPT
    )
    expect(mocks.existsSync).toHaveBeenCalledWith(HOST_TRANSCRIPT)
  })

  it('keeps the host transcript first and never enumerates WSL homes on a host hit', async () => {
    mocks.hostExisting.add(HOST_TRANSCRIPT)
    mocks.wslFiles.set(UBUNTU_TRANSCRIPT, true)

    await expect(resolveSessionFilePath('antigravity', CONVERSATION_ID)).resolves.toBe(
      HOST_TRANSCRIPT
    )
    expect(listRunningWslDistrosAsync).not.toHaveBeenCalled()
  })

  it('treats an explicit brain root as exact and skips the WSL fallback', async () => {
    mocks.wslFiles.set(UBUNTU_TRANSCRIPT, true)

    await expect(
      resolveSessionFilePath('antigravity', CONVERSATION_ID, {
        antigravityBrainDir: 'C:\\isolated\\brain'
      })
    ).resolves.toBeNull()
    expect(listRunningWslDistrosAsync).not.toHaveBeenCalled()
  })

  it('probes running distros once per attempt, not once per candidate', async () => {
    mocks.wslFiles.set(DEBIAN_TRANSCRIPT, true)

    await expect(resolveSessionFilePath('antigravity', CONVERSATION_ID)).resolves.toBe(
      DEBIAN_TRANSCRIPT
    )
    expect(listRunningWslDistrosAsync).toHaveBeenCalledTimes(1)
  })

  it('does not start WSL discovery for a cancelled lookup', async () => {
    const controller = new AbortController()
    mocks.existsSync.mockImplementationOnce(() => {
      controller.abort()
      return false
    })

    await expect(
      resolveSessionFilePath('antigravity', CONVERSATION_ID, {}, controller.signal)
    ).rejects.toThrow()
    expect(listRunningWslDistrosAsync).not.toHaveBeenCalled()
    expect(listRunningWslHomeDirsAsync).not.toHaveBeenCalled()
  })

  it('lets a responsive distro win when another distro stalls', async () => {
    mocks.wslFiles.set(UBUNTU_TRANSCRIPT, 'stall')
    mocks.wslFiles.set(DEBIAN_TRANSCRIPT, true)

    await expect(resolveSessionFilePath('antigravity', CONVERSATION_ID)).resolves.toBe(
      DEBIAN_TRANSCRIPT
    )
  })

  it('reports a stalled distro as unavailable instead of missing', async () => {
    mocks.wslFiles.set(UBUNTU_TRANSCRIPT, 'stall')

    await expect(resolveSessionFilePath('antigravity', CONVERSATION_ID)).rejects.toBeInstanceOf(
      WslTranscriptFsError
    )
  })

  it('rejects a path-shaped conversation id before touching any filesystem', async () => {
    await expect(resolveSessionFilePath('antigravity', '..\\..\\secrets')).resolves.toBeNull()
    expect(mocks.existsSync).not.toHaveBeenCalled()
    expect(listRunningWslDistrosAsync).not.toHaveBeenCalled()
  })

  it('does not replace an attested distro miss with an id match in another guest', async () => {
    mocks.wslFiles.set(DEBIAN_TRANSCRIPT, true)

    await expect(
      resolveSessionFilePath('antigravity', CONVERSATION_ID, { wslDistro: 'Ubuntu' })
    ).resolves.toBeNull()
    expect(listRunningWslDistrosAsync).not.toHaveBeenCalled()
  })

  it('does not replace a missing guest hook path with an id match', async () => {
    mocks.wslFiles.set(DEBIAN_TRANSCRIPT, true)

    await expect(
      resolveSessionFilePath('antigravity', CONVERSATION_ID, {
        transcriptPath: `/home/ada/.gemini/antigravity-cli/brain/other/.system_generated/logs/transcript.jsonl`
      })
    ).resolves.toBeNull()
    expect(mocks.wslGatedAccess).not.toHaveBeenCalledWith(
      DEBIAN_TRANSCRIPT,
      expect.anything(),
      expect.anything()
    )
  })

  it('never enumerates WSL homes off Windows', async () => {
    setPlatform('linux')
    mocks.wslFiles.set(UBUNTU_TRANSCRIPT, true)

    await expect(resolveSessionFilePath('antigravity', CONVERSATION_ID)).resolves.toBeNull()
    expect(listRunningWslDistrosAsync).not.toHaveBeenCalled()
  })
})
