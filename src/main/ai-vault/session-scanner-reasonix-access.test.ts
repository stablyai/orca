import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createRelayAiVaultFilesystemProvider } from '../../relay/ai-vault-service-filesystem'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { reasonixFrameRecords } from './session-scanner-reasonix-frames'
import { reasonixHistoryAccess } from './session-scanner-reasonix-access'
import { projectReasonixHistory } from './session-scanner-reasonix-projection'

let root = ''
let path = ''
const id = 'c6ba053c5f6f35229354dbd95635c82d'
const platform = getRemoteHostPlatform(
  process.platform === 'win32'
    ? 'win32-x64'
    : process.platform === 'darwin'
      ? 'darwin-arm64'
      : 'linux-x64'
)
const provider = createRelayAiVaultFilesystemProvider()
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-reasonix-access-'))
  const session = join(root, 'projects', '-explicit-folder', 'sessions-v4', id)
  await mkdir(session, { recursive: true })
  path = join(session, 'events.frames')
  for (const [source, destination] of [
    ['reasonix-1-39-7-loopback.frames', 'events.frames'],
    ['reasonix-1-39-7-loopback.manifest.json', 'manifest.json']
  ]) {
    await copyFile(join(__dirname, '__fixtures__', source), join(session, destination))
  }
})
afterEach(async () => {
  provider.dispose()
  await rm(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

it('reads the actual binary store beside its execution host without deriving cwd from a slug', async () => {
  const access = await reasonixHistoryAccess(provider, platform, path)
  expect(access.cwd).toBeNull()
  const read = provider.readTranscriptBytes
  if (!read) {
    throw new Error('Execution-host byte reader missing')
  }
  const projection = await projectReasonixHistory(
    read(path, undefined, 'reasonix-v4'),
    access.readContent
  )
  expect(
    projection.messages.some(
      (message) => message.record.content === 'Loopback transport proof only.'
    )
  ).toBe(true)
})

it('reads referenced objects only from digest-derived native content directories', async () => {
  const content = Buffer.from('{"messages":[]}')
  const digest = createHash('sha256').update(content).digest('hex')
  const object = join(
    root,
    'projects',
    '-explicit-folder',
    'sessions-v4',
    '.content-v1',
    'objects',
    digest.slice(0, 2),
    digest.slice(2, 4),
    digest
  )
  await mkdir(join(object, '..'), { recursive: true })
  await writeFile(object, content)
  const access = await reasonixHistoryAccess(provider, platform, path)
  expect(await access.readContent(digest, content.length)).toEqual(content)
  await expect(access.readContent('../outside', 1)).rejects.toThrow('identity')
  await expect(access.readContent(digest, content.length - 1)).rejects.toThrow('budget')
})

it('refuses symlink metadata instead of following it', async () => {
  const original = provider.stat
  vi.spyOn(provider, 'stat').mockImplementation(async (file) => {
    const stat = await original(file)
    return file.endsWith('manifest.json') && stat ? { ...stat, type: 'symlink' } : stat
  })
  await expect(reasonixHistoryAccess(provider, platform, path)).rejects.toThrow('not regular')
})

it('rejects a host without byte reads and a canceled read before filesystem access', async () => {
  await expect(
    reasonixHistoryAccess({ ...provider, readTranscriptBytes: undefined }, platform, path)
  ).rejects.toThrow('execution-host')
  const stat = vi.spyOn(provider, 'stat')
  const controller = new AbortController()
  controller.abort()
  await expect(reasonixHistoryAccess(provider, platform, path, controller.signal)).rejects.toThrow()
  expect(stat).not.toHaveBeenCalled()
})

it('requires explicit canonical RX4F format on the host byte reader', async () => {
  const read = provider.readTranscriptBytes
  if (!read) {
    throw new Error('Execution-host reader missing')
  }
  async function collect(source: AsyncIterable<Buffer>) {
    for await (const chunk of source) {
      expect(Buffer.isBuffer(chunk)).toBe(true)
    }
  }
  await expect(collect(read(path))).rejects.toThrow('Binary session transcript')
  const unrelated = join(root, 'unrelated.frames')
  await copyFile(path, unrelated)
  await expect(collect(read(unrelated, undefined, 'reasonix-v4'))).rejects.toThrow(
    'canonical Reasonix'
  )
  await writeFile(path, 'unrelated text')
  await expect(collect(read(path, undefined, 'reasonix-v4'))).rejects.toThrow('canonical Reasonix')
})

function hostByteReader() {
  const read = provider.readTranscriptBytes
  if (!read) {
    throw new Error('Execution-host byte reader missing')
  }
  return read
}

async function drain(source: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of source) {
    // Consume: these cases assert rejection, not payload.
  }
}

function sessionFile(name: string): string {
  return join(root, 'projects', '-explicit-folder', 'sessions-v4', id, name)
}

// Why the skip: FIFOs are a POSIX shape; Windows has no mkfifo and no equivalent hazard.
it.skipIf(process.platform === 'win32')(
  'refuses a task-owned FIFO manifest before it is opened',
  async () => {
    const manifest = sessionFile('manifest.json')
    await rm(manifest)
    await promisify(execFile)('mkfifo', [manifest])
    // Without the pre-open regular-file guard the open never settles, so rejecting at all is the oracle.
    await expect(reasonixHistoryAccess(provider, platform, path)).rejects.toThrow(
      'not a regular file or directory'
    )
  }
)

it.skipIf(process.platform === 'win32')(
  'refuses the final transcript symlink instead of reading its target',
  async () => {
    const outside = join(root, 'outside.frames')
    await copyFile(path, outside)
    await rm(path)
    await symlink(outside, path)
    await expect(reasonixHistoryAccess(provider, platform, path)).rejects.toThrow(
      'not a regular file'
    )
    await expect(drain(hostByteReader()(path, undefined, 'reasonix-v4'))).rejects.toThrow(
      'regular session file'
    )
  }
)

it('rejects frame magic whose damaged bytes still decode as RX4F in ASCII', async () => {
  const data = await readFile(path)
  for (let at = 0; at < data.length;) {
    for (let index = 0; index < 4; index += 1) {
      data[at + index] |= 0b1000_0000
    }
    at += 12 + data.readUInt32BE(at + 4)
  }
  expect(data.subarray(0, 4).toString('hex')).toBe('d2d8b4c6')
  expect(data.subarray(0, 4).toString('ascii')).toBe('RX4F')
  await writeFile(path, data)
  await expect(drain(hostByteReader()(path, undefined, 'reasonix-v4'))).rejects.toThrow(
    'canonical Reasonix'
  )
  async function* once(): AsyncGenerator<Buffer> {
    yield data
  }
  await expect(drain(reasonixFrameRecords(once()))).rejects.toThrow('Invalid Reasonix frame magic')
})
