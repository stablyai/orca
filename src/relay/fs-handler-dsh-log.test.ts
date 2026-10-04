import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { expect, it } from 'vitest'
import { RelayDispatcher } from './dispatcher'
import { FsHandler } from './fs-handler'
import { RelayContext } from './context'
import { SshChannelMultiplexer } from '../main/ssh/ssh-channel-multiplexer'

it('opens actual-schema compressed persistence through the host read-file RPC while preserving old binary reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-relay-dsh-'))
  let receive!: (data: Buffer) => void
  const host = new RelayDispatcher((data) => receive(Buffer.from(data)))
  const mux = new SshChannelMultiplexer({
    write: (data) => host.feed(data),
    onData: (callback) => {
      receive = callback
    },
    onClose: () => {}
  })
  const handler = new FsHandler(host, new RelayContext())
  try {
    const content = await readFile(
      new URL('../main/ai-vault/__fixtures__/dsh-v4-auth-rejected.jsonl', import.meta.url),
      'utf8'
    )
    const directory = join(root, 'sessions', 'project', 'session-proof')
    await mkdir(directory, { recursive: true })
    const path = join(directory, 'session.v4.jsonl.zstd')
    await writeFile(
      path,
      Buffer.concat(
        content
          .split('\n')
          .filter(Boolean)
          .map((line) => zstdCompressSync(Buffer.from(`${line}\n`)))
      )
    )
    expect(await mux.request('fs.readFile', { filePath: path, decodeDshHistory: true })).toEqual({
      content,
      isBinary: false,
      decodedDshHistory: true
    })
    expect(await mux.request('fs.readFile', { filePath: path })).toMatchObject({ isBinary: true })
    await expect(
      mux.request('fs.readFile', { filePath: join(root, 'unrelated.zstd'), decodeDshHistory: true })
    ).rejects.toThrow('canonical')
  } finally {
    handler.dispose()
    mux.dispose()
    host.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
