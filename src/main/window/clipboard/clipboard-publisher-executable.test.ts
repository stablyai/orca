import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { stageClipboardPublisher } from './clipboard-publisher-executable'

let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-clipboard-publisher-'))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

it('keeps each executable intact after its source mount disappears or updates', async () => {
  const source = join(directory, 'bundled')
  await writeFile(source, 'first release')
  const first = await stageClipboardPublisher(source, directory)
  await writeFile(source, 'second release')
  const second = await stageClipboardPublisher(source, directory)
  await rm(source)
  expect(first).not.toBe(second)
  expect(await readFile(first, 'utf8')).toBe('first release')
  expect(await readFile(second, 'utf8')).toBe('second release')
  if (process.platform !== 'win32') {
    expect((await stat(first)).mode & 0o777).toBe(0o700)
  }
})

it('publishes complete executables atomically when two clients copy concurrently', async () => {
  const source = join(directory, 'bundled')
  await writeFile(source, 'native publisher')
  const [first, second] = await Promise.all([
    stageClipboardPublisher(source, directory),
    stageClipboardPublisher(source, directory)
  ])
  expect(first).toBe(second)
  expect(await readFile(first, 'utf8')).toBe('native publisher')
  expect(await readdir(join(directory, 'clipboard-publishers'))).toHaveLength(1)
})

it('repairs a damaged cache entry without replacing a running executable in place', async () => {
  const source = join(directory, 'bundled')
  await writeFile(source, 'native publisher')
  const executable = await stageClipboardPublisher(source, directory)
  await writeFile(executable, 'damaged')
  expect(await stageClipboardPublisher(source, directory)).toBe(executable)
  expect(await readFile(executable, 'utf8')).toBe('native publisher')
})

it.skipIf(process.platform === 'win32')(
  'restores executable mode on a reused cache entry',
  async () => {
    const source = join(directory, 'bundled')
    await writeFile(source, 'native publisher')
    const executable = await stageClipboardPublisher(source, directory)
    await chmod(executable, 0o600)
    expect(await stageClipboardPublisher(source, directory)).toBe(executable)
    expect((await stat(executable)).mode & 0o777).toBe(0o700)
  }
)
