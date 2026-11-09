/** Exercise real failure producers for directory upload, system SFTP and runtime self-test. */
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../shared/node-runtime-pin'
import type { SshTarget } from '../../../shared/ssh-types'
import '@orca/process-host'
import '../../managed-server/install/orcad-remote-node-runtime-report'
import '../../managed-server/install/orcad-remote-node-runtime'
import '../remote-host/ssh-remote-platform'
import { findSystemSsh } from './system-ssh-binary'
import { uploadDirectoryViaSystemSsh } from './file-transfer/system-ssh-file-transfer'
import './file-transfer/system-ssh-sftp-transfer'
import { isHostAnsweredSystemSshExit } from './system-ssh-operation-lifecycle'

vi.mock('@orca/process-host', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runProcess: vi.fn()
}))
vi.mock('./system-ssh-args', () => ({ buildSshArgs: () => ['--', 'host'] }))
vi.mock('./system-ssh-binary', () => ({
  findSystemSsh: vi.fn(() => '/usr/bin/ssh')
}))

const posix = process.platform !== 'win32'
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ssh args are mocked, so the target is never read.
const target = {} as SshTarget
let scratch: string

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'orca-answered-producers-'))
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(scratch, { recursive: true, force: true })
})

async function script(name: string, body: string): Promise<string> {
  const path = join(scratch, name)
  await writeFile(path, `#!/bin/sh\n${body}\n`)
  await chmod(path, 0o755)
  return path
}

describe.runIf(posix)('system-ssh directory upload', () => {
  it('keeps the remote ENOSPC when the far end closes mid-stream and local tar then fails to write', async () => {
    // Keep tar writing past SSH exit so downstream failure occurs on BSD tar too.
    const dir = join(scratch, 'large')
    await mkdir(dir)
    await writeFile(join(dir, 'runtime.bin'), randomBytes(8 * 1024 * 1024))
    vi.mocked(findSystemSsh).mockReturnValue(
      await script(
        'ssh',
        'head -c 1024 >/dev/null\necho "tar: Cannot write: No space left on device" >&2\nexit 2'
      )
    )
    for (let attempt = 0; attempt < 3; attempt++) {
      const error = await uploadDirectoryViaSystemSsh(target, dir, '/remote').catch(
        (e: unknown) => e
      )
      expect(String(error)).toContain('No space left on device')
      expect(isHostAnsweredSystemSshExit(error)).toBe(true)
    }
  })
})
