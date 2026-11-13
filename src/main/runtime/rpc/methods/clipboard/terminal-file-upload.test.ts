import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SshHostNotServedError } from '../../../../providers/ssh-host-not-served-error'
import { TerminalFileUploadStore } from '../../../../terminal-file-upload/terminal-file-upload-store'
import { terminalFileUploadHandlers } from './terminal-file-upload'

const NOT_FOUND = 'Terminal file upload was not found'
type Caller = { clientKind?: 'mobile'; clientId?: string }
const phoneA: Caller = { clientKind: 'mobile', clientId: 'device-a' }
const phoneB: Caller = { clientKind: 'mobile', clientId: 'device-b' }
const desktop: Caller = {}

describe('terminal file upload RPC handlers', () => {
  let root: string
  let handlers: ReturnType<typeof terminalFileUploadHandlers>

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'terminal-file-upload-rpc-test-'))
    handlers = terminalFileUploadHandlers(new TerminalFileUploadStore(() => root))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('refuses a file for an SSH worktree', async () => {
    await expect(
      handlers.start({ name: 'a.txt', byteLength: 1, connectionId: 'ssh-1' }, phoneA)
    ).rejects.toBeInstanceOf(SshHostNotServedError)
  })

  it("keeps a phone's upload out of reach of another phone and the desktop", async () => {
    const { uploadId } = await handlers.start(
      { name: 'a.txt', byteLength: 2, connectionId: null },
      phoneA
    )
    const append = { uploadId, offset: 0, contentBase64: Buffer.from('hi').toString('base64') }
    for (const caller of [phoneB, desktop]) {
      await expect(handlers.append(append, caller)).rejects.toThrow(NOT_FOUND)
      await expect(handlers.commit({ uploadId }, caller)).rejects.toThrow(NOT_FOUND)
      await expect(handlers.abort({ uploadId }, caller)).rejects.toThrow(NOT_FOUND)
    }
    await handlers.append(append, phoneA)
    await expect(handlers.commit({ uploadId }, phoneA)).resolves.toMatchObject({ byteLength: 2 })
  })
})
