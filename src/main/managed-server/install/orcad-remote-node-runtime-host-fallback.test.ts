import type * as ExecCommandModule from '../../ssh/remote-exec/remote-exec-command'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcadHostTransport } from '../../ssh/orcad-host-transport'
import { ensureRemoteOrcadNodeRuntime } from './orcad-remote-node-runtime'
import {
  REMOTE_NODE_RUNTIME_MISSING,
  REMOTE_NODE_RUNTIME_READY
} from '../../ssh/orcad-remote-node-runtime-report'
import { execCommand } from '../../ssh/remote-exec/remote-exec-command'
import { uploadRelayDirectory } from './remote-install-transfers'
import { getRemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import { pinnedNodeRuntimeAsset } from '../../../shared/node-runtime-pin'
import { DesktopDownloadUnreachableError } from '../../node-runtime/pinned-runtime-materializer'
import { setNodeDistMirrorSettingReader } from '../../node-runtime/node-dist-mirror-setting'
import {
  HOST_NODE_DOWNLOAD_FAILED,
  HOST_NODE_DOWNLOAD_OK,
  NodeRuntimeUnreachableError
} from './remote-node-runtime-host-download'

vi.mock('../../ssh/remote-exec/remote-exec-command', async (importOriginal) => ({
  ...(await importOriginal<typeof ExecCommandModule>()),
  execCommand: vi.fn()
}))
vi.mock('./remote-install-transfers', () => ({ uploadRelayDirectory: vi.fn(async () => {}) }))

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every remote call goes through the mocked execCommand.
const conn = {} as OrcadHostTransport
const host = getRemoteHostPlatform('linux-x64')
const TARGET = 'linux-x64-glibc'
const OFFLINE_PATH = '/Users/me/Library/Application Support/Orca/orcad-artifacts/node/archives/x'
const refused = (): Promise<string> => Promise.reject(new Error('net::ERR_CONNECTION_REFUSED'))

afterEach(() => {
  vi.mocked(execCommand).mockReset()
  vi.mocked(uploadRelayDirectory).mockClear()
})

/** A fresh POSIX host; `download` is what its curl/wget step prints. */
function freshHost(download: string): string[] {
  const commands: string[] = []
  vi.mocked(execCommand).mockImplementation(async (_conn, command) => {
    commands.push(command)
    if (command.includes('command -v curl')) {
      return download
    }
    if (command.includes('tar -xzf')) {
      return REMOTE_NODE_RUNTIME_READY
    }
    if (command.includes(REMOTE_NODE_RUNTIME_MISSING)) {
      return REMOTE_NODE_RUNTIME_MISSING
    }
    return command.includes('2>/dev/null') ? 'OK' : ''
  })
  return commands
}

function ensure(archivePath: () => Promise<string>, signal?: AbortSignal) {
  return ensureRemoteOrcadNodeRuntime({
    conn,
    host,
    slotDir: '/home/me/.orca-remote/orcad-0.1.0+abc',
    target: TARGET,
    archivePath,
    offlineArchivePath: OFFLINE_PATH,
    signal
  })
}

describe('pinned Node when this computer cannot download it', () => {
  it('has the host download it and promotes that copy, with nothing uploaded', async () => {
    const commands = freshHost(HOST_NODE_DOWNLOAD_OK)

    const result = await ensure(refused)

    expect(result.transfer).toBe('host-downloaded')
    expect(uploadRelayDirectory).not.toHaveBeenCalled()
    const promote = commands.find((command) => command.includes('tar -xzf'))
    expect(promote).toContain(pinnedNodeRuntimeAsset(TARGET).archive)
    expect(promote).toContain(pinnedNodeRuntimeAsset(TARGET).executableSha256)
  })

  it('also tries the host when the desktop got a file that failed the pin', async () => {
    freshHost(HOST_NODE_DOWNLOAD_OK)
    const blockPage = () => Promise.reject(new Error('Node archive checksum mismatch'))

    await expect(ensure(blockPage)).resolves.toMatchObject({ transfer: 'host-downloaded' })
  })

  it('names both attempts and the offline copy path when the host cannot download either', async () => {
    freshHost(
      `${HOST_NODE_DOWNLOAD_FAILED}\nORCA_RUNTIME_EXIT=7\ncurl: (7) Failed to connect to nodejs.org`
    )

    const failure = await ensure(refused).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(NodeRuntimeUnreachableError)
    const message = String(failure)
    expect(message).toContain('net::ERR_CONNECTION_REFUSED')
    expect(message).toContain('curl: (7) Failed to connect to nodejs.org')
    expect(message).toContain(OFFLINE_PATH)
    expect(message).toContain('Settings > Advanced > Network > Node.js download mirror')
    expect(message).toContain("NODEJS_ORG_MIRROR in this computer's environment")
    expect(failure).toMatchObject({ mirror: 'unset' })
    expect(uploadRelayDirectory).not.toHaveBeenCalled()
  })

  it('records that both attempts went through the configured mirror', async () => {
    freshHost(`${HOST_NODE_DOWNLOAD_FAILED}\nmirror: curl exit 7`)
    setNodeDistMirrorSettingReader(() => 'https://npmmirror.com/mirrors/node')
    try {
      const failure = await ensure(refused).catch((error: unknown) => error)
      expect(failure).toMatchObject({ name: 'NodeRuntimeUnreachableError', mirror: 'tried' })
      expect(String(failure)).toContain('check the mirror of nodejs.org/dist in Settings')
    } finally {
      setNodeDistMirrorSettingReader(null)
    }
  })

  it('offers no mirror for a build nodejs.org/dist does not carry', async () => {
    freshHost(`${HOST_NODE_DOWNLOAD_FAILED}\nnodejs.org: curl exit 7`)
    const failure = await ensureRemoteOrcadNodeRuntime({
      conn,
      host: getRemoteHostPlatform('linux-arm64'),
      slotDir: '/home/me/.orca-remote/orcad-0.1.0+abc',
      target: 'linux-arm64-musl',
      archivePath: refused
    }).catch((error: unknown) => error)
    expect(failure).toMatchObject({ name: 'NodeRuntimeUnreachableError', mirror: 'unsupported' })
    expect(String(failure)).not.toContain('Node.js download mirror')
  })

  it("quotes only this computer's short reason, not its standalone advice", async () => {
    freshHost(`${HOST_NODE_DOWNLOAD_FAILED}\nnodejs.org: curl exit 7`)
    const desktop = () =>
      Promise.reject(
        new DesktopDownloadUnreachableError(
          "This computer couldn't download Node ... so the host doesn't need internet access",
          'https://nodejs.org/dist/x: net::ERR_CONNECTION_REFUSED',
          new Error('net::ERR_CONNECTION_REFUSED')
        )
      )

    const message = String(await ensure(desktop).catch((error: unknown) => error))

    expect(message).toContain(
      'This computer: https://nodejs.org/dist/x: net::ERR_CONNECTION_REFUSED.'
    )
    expect(message).not.toContain("the host doesn't need internet access")
  })

  it('does not try the host once the connect was cancelled', async () => {
    const commands = freshHost(HOST_NODE_DOWNLOAD_OK)
    const controller = new AbortController()
    const cancelled = () => {
      controller.abort()
      return Promise.reject(new Error('aborted'))
    }

    await expect(ensure(cancelled, controller.signal)).rejects.toThrow('aborted')
    expect(commands.some((command) => command.includes('command -v curl'))).toBe(false)
  })

  it('still uploads the desktop copy when there is one', async () => {
    const commands = freshHost(HOST_NODE_DOWNLOAD_OK)
    const cache = mkdtempSync(join(tmpdir(), 'orca-runtime-cache-'))
    const archive = join(cache, pinnedNodeRuntimeAsset(TARGET).archive)
    writeFileSync(archive, 'archive')
    try {
      await expect(ensure(async () => archive)).resolves.toMatchObject({ transfer: 'uploaded' })
      expect(uploadRelayDirectory).toHaveBeenCalledTimes(1)
      expect(commands.some((command) => command.includes('command -v curl'))).toBe(false)
    } finally {
      rmSync(cache, { recursive: true, force: true })
    }
  })
})
