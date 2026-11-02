import type * as ExecCommandModule from '../../ssh/remote-exec/remote-exec-command'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureRemoteOrcadNodeRuntime } from './orcad-remote-node-runtime'
import {
  REMOTE_NODE_RUNTIME_MISSING,
  REMOTE_NODE_RUNTIME_READY
} from '../../ssh/orcad-remote-node-runtime-report'
import { execCommand } from '../../ssh/remote-exec/remote-exec-command'
import { uploadRemoteInstallDirectory } from './remote-install-transfers'
import { getRemoteHostPlatform } from '../../ssh/ssh-remote-platform'

import { HOST_NODE_DOWNLOAD_OK } from './remote-node-runtime-host-download'

import { unusedOrcadHostTransport } from '../../ssh/unused-host-transport.test-fixture'

vi.mock('../../ssh/remote-exec/remote-exec-command', async (importOriginal) => ({
  ...(await importOriginal<typeof ExecCommandModule>()),
  execCommand: vi.fn()
}))
vi.mock('./remote-install-transfers', () => ({
  uploadRemoteInstallDirectory: vi.fn(async () => {})
}))

const conn = unusedOrcadHostTransport()
const host = getRemoteHostPlatform('linux-x64')
const TARGET = 'linux-x64-glibc'
const OFFLINE_PATH = '/Users/me/Library/Application Support/Orca/orcad-artifacts/node/archives/x'

afterEach(() => {
  vi.mocked(execCommand).mockReset()
  vi.mocked(uploadRemoteInstallDirectory).mockClear()
})

/** Model a fresh host with a configurable curl/wget download verdict. */
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
  it('also tries the host when the desktop got a file that failed the pin', async () => {
    freshHost(HOST_NODE_DOWNLOAD_OK)
    const blockPage = () => Promise.reject(new Error('Node archive checksum mismatch'))

    await expect(ensure(blockPage)).resolves.toMatchObject({ transfer: 'host-downloaded' })
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
})
