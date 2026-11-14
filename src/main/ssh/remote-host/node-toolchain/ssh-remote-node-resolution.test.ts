import type * as ExecCommandModule from '../../remote-exec/remote-exec-command'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnection } from '../../connection/ssh-connection'

const execCommandMock = vi.hoisted(() => vi.fn())

vi.mock('../../remote-exec/remote-exec-command', async (importOriginal) => ({
  ...(await importOriginal<typeof ExecCommandModule>()),
  execCommand: execCommandMock
}))

// Why: await import() is required so vi.mock() above registers before the
// module under test is evaluated. Static import would bypass the mock.
const { resolveRemoteNodePath } = await import('./ssh-remote-node-resolution')

const conn = {} as SshConnection

describe('resolveRemoteNodePath', () => {
  beforeEach(() => {
    execCommandMock.mockReset()
  })

  it.runIf(process.platform !== 'win32')('accepts npm elsewhere on PATH', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'orca-split-node-npm-'))
    try {
      const nodePath = path.join(root, 'selected node', 'bin', 'node')
      const npmBinDir = path.join(root, 'npm elsewhere', 'bin')
      mkdirSync(path.dirname(nodePath), { recursive: true })
      mkdirSync(npmBinDir, { recursive: true })
      writeFileSync(nodePath, '#!/bin/sh\nprintf "v22.22.0\\n"\n')
      writeFileSync(path.join(npmBinDir, 'npm'), '#!/bin/sh\nprintf "11.13.0\\n"\n')
      chmodSync(nodePath, 0o755)
      chmodSync(path.join(npmBinDir, 'npm'), 0o755)

      execCommandMock
        .mockResolvedValueOnce(`${nodePath}\n${path.join(root, 'fallback', 'bin', 'node')}\n`)
        .mockImplementationOnce((_conn: SshConnection, command: string) =>
          Promise.resolve(
            execFileSync('/bin/sh', ['-c', command], {
              encoding: 'utf8',
              env: { HOME: root, PATH: npmBinDir }
            })
          )
        )

      await expect(resolveRemoteNodePath(conn)).resolves.toBe(nodePath)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
