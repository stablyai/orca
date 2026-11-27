import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { SshConnectionManager } from '../connection/ssh-connection-manager'
import { browseSshDirectory } from './ssh-remote-directory-browse'

function fakeManager(stdoutPackets: Buffer[]) {
  const channel = Object.assign(new EventEmitter(), { stderr: new EventEmitter() })
  setImmediate(() => {
    for (const packet of stdoutPackets) {
      channel.emit('data', packet)
    }
    channel.emit('exit', 0)
    channel.emit('close', 0)
  })
  const conn = { execWithClosedStdin: async () => channel }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: browseSshDirectory only reads getConnection(...).execWithClosedStdin
  return { getConnection: () => conn } as unknown as SshConnectionManager
}

describe('browseSshDirectory', () => {
  it('keeps a multibyte name intact when an SSH packet splits it mid-character', async () => {
    const bytes = Buffer.from('/home/me\n项目/\n')
    const split = bytes.indexOf(Buffer.from('项')) + 1
    const manager = fakeManager([bytes.subarray(0, split), bytes.subarray(split)])

    const result = await browseSshDirectory(manager, 'target', '/home/me')

    expect(result.entries).toEqual([{ name: '项目', isDirectory: true }])
  })
})
