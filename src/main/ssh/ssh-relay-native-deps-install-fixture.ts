// Why: shared by the native-deps install specs so each file stays under the max-lines cap; the
// vi.mock of ./ssh-relay-deploy-helpers in the importing spec is hoisted, so execCommand is mocked here too.
import { EventEmitter } from 'node:events'
import { vi } from 'vitest'

import { execCommand } from './ssh-relay-deploy-helpers'
import type { SshConnection } from './ssh-connection'

export type SftpWriteCapture = {
  paths: string[]
  contents: Record<string, string>
  // execCommand call count observed when ws.end() ran, per path — pins "package.json written before Bun install".
  execCallCountAtWrite: Record<string, number>
}

type SftpCallback = (err: Error | null, resolved?: string) => void
const NO_SUCH_SFTP_FILE = Object.assign(new Error('No such file'), { code: 2 })
export function makeMockConnection(capture: SftpWriteCapture): SshConnection {
  // Why: production attaches/removes real listeners (including prependOnceListener), so the fake must be an emitter.
  const sftpCreate = (): unknown => {
    const sftp = new EventEmitter()
    return Object.assign(sftp, {
      mkdir: vi.fn((_p: string, cb: SftpCallback) => cb(null)),
      // This host's shell home and SFTP start directory agree, so no namespace redirect is possible.
      realpath: vi.fn((_p: string, cb: SftpCallback) => cb(null, '/home/u')),
      lstat: vi.fn((_p: string, cb: SftpCallback) => cb(NO_SUCH_SFTP_FILE)),
      createWriteStream: vi.fn().mockImplementation((path: string) => {
        capture.paths.push(path)
        const ws = new EventEmitter()
        return Object.assign(ws, {
          end: vi.fn((data?: string) => {
            capture.contents[path] = `${capture.contents[path] ?? ''}${data ?? ''}`
            capture.execCallCountAtWrite[path] = vi.mocked(execCommand).mock.calls.length
            setTimeout(() => ws.emit('close'), 0)
          })
        })
      }),
      end: vi.fn(() => setTimeout(() => sftp.emit('close'), 0))
    })
  }
  return {
    canRunConcurrentExecCommands: vi.fn().mockReturnValue(false),
    exec: vi.fn().mockResolvedValue({
      on: vi.fn(),
      stderr: { on: vi.fn() },
      stdin: {},
      stdout: { on: vi.fn() },
      close: vi.fn()
    }),
    sftp: vi.fn().mockImplementation(() => Promise.resolve(sftpCreate()))
  } as unknown as SshConnection
}

export type ExecResponse = string | { reject: string }

export const WATCHER_MISSING_PROBE = 'ORCA-NATIVE-DEPS-MISSING:@parcel/watcher\nMISSING'

const STAGE_OWNER = '.sftp-namespace-00000000000000000000000000000000'
export function makeStagedFirstInstallExecPrefix(): ExecResponse[] {
  return [
    '__ORCA_REMOTE_PLATFORM__ Linux x86_64',
    '/home/u',
    '', // stale-stage recovery
    `__ORCA_UPLOAD_STAGE_SLOT__${STAGE_OWNER}:slot-0`,
    '', // install namespace
    `__ORCA_UPLOAD_STAGE_PROMOTION__${STAGE_OWNER}:PROMOTED`
  ]
}
export function makeSuccessfulBunInstallResponses(): ExecResponse[] {
  return [...makeStagedFirstInstallExecPrefix(), '', '', 'DEAD', '', 'READY']
}
