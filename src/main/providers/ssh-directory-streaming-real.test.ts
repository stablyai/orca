import { generateKeyPairSync } from 'node:crypto'
import { Client, Server } from 'ssh2'
import type { SFTPWrapper } from 'ssh2'
import { describe, expect, it } from 'vitest'
import { readDirectoryEntriesViaSftp } from './ssh-filesystem-provider-sftp'
import { readSftpDirectory } from './ssh-sftp-directory-listing'

async function createServer() {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' }
  })
  let reads = 0
  let closes = 0
  const positions = new Map<string, number>()
  const server = new Server({ hostKeys: [privateKey] }, (connection) => {
    connection
      .on('authentication', (context) => context.accept())
      .on('ready', () => {
        connection.on('session', (accept) => {
          accept().on('sftp', (acceptSftp) => {
            const stream = acceptSftp()
            stream.on('OPENDIR', (id, path) => {
              positions.set(path, 0)
              stream.handle(id, Buffer.from(path))
            })
            stream.on('READDIR', (id, handle) => {
              reads++
              const key = handle.toString()
              const start = positions.get(key) ?? 0
              if (start >= 1000) {
                stream.status(id, 1)
                return
              }
              positions.set(key, start + 100)
              stream.name(
                id,
                Array.from({ length: 100 }, (_, offset) => ({
                  filename: `file-${start + offset}.txt`,
                  longname: '',
                  attrs: { mode: 0o100644, size: 0, uid: 0, gid: 0, atime: 0, mtime: 0 }
                }))
              )
            })
            stream.on('CLOSE', (id, handle) => {
              closes++
              positions.delete(handle.toString())
              stream.status(id, 0)
            })
          })
        })
      })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('No fixture port')
  }
  const client = new Client()
  await new Promise<void>((resolve, reject) => {
    client.once('ready', resolve).once('error', reject)
    client.connect({
      host: '127.0.0.1',
      port: address.port,
      username: 'fixture',
      password: 'fixture'
    })
  })
  const sftp = await new Promise<SFTPWrapper>((resolve, reject) =>
    client.sftp((error, value) => (error ? reject(error) : resolve(value)))
  )
  return {
    sftp,
    counts: () => ({ reads, closes }),
    close: async () => {
      sftp.end()
      client.end()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }
}

describe('real SFTP directory packet contract', () => {
  it('stops server enumeration after one packet and closes the remote handle', async () => {
    const fixture = await createServer()
    try {
      for await (const entry of readDirectoryEntriesViaSftp(fixture.sftp, '/early')) {
        expect(entry.filename).toBe('file-0.txt')
        break
      }
      expect(fixture.counts()).toEqual({ reads: 1, closes: 1 })
      expect(await readSftpDirectory(fixture.sftp, '/complete')).toHaveLength(1000)
      expect(fixture.counts()).toEqual({ reads: 12, closes: 2 })
    } finally {
      await fixture.close()
    }
  })
})
