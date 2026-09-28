import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { windowsPowerShellPath } from '../../shared/child-process/windows-system-binary'
import { runProcess } from '../../shared/child-process/run-process'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import { decodeRemotePowerShellScript } from './ssh-remote-powershell'
import {
  parseRelayBunRuntimeResult,
  probeRelayBunRuntimeCommand,
  promoteRelayBunRuntimeCommand
} from './ssh-relay-bun-runtime-commands'

const windows = process.platform === 'win32'
const host = getRemoteHostPlatform(windows ? 'win32-x64' : 'linux-x64')
const content = 'verified Bun bytes'
const expectedHash = createHash('sha256').update(content).digest('hex')
const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "orca bun '$ "))
  directories.push(directory)
  const source = join(directory, 'upload', 'bun')
  const executable = join(directory, 'cache', 'bun')
  await mkdir(join(directory, 'upload'))
  await writeFile(source, content)
  return { directory, source, executable, host, expectedHash, repairToken: 'a'.repeat(24) }
}
const run = async (command: string) => {
  const result = await runProcess({
    program: windows ? windowsPowerShellPath() : '/bin/sh',
    args: windows
      ? ['-NoProfile', '-NonInteractive', '-Command', decodeRemotePowerShellScript(command)]
      : ['-c', command],
    timeoutMs: 15_000
  })
  expect(result.timedOut, `Runtime publication shell timed out: ${result.stderr}`).toBe(false)
  return result
}

function parseRuntimePath(output: string): string | undefined {
  const path = parseRelayBunRuntimeResult(output)
  return path ? resolve(path) : undefined
}

describe('runtime publication without host Node', { timeout: 30_000 }, () => {
  it('verifies and publishes an uploaded runtime with shell metacharacters in its path', async () => {
    const f = await fixture()
    const result = await run(promoteRelayBunRuntimeCommand(f))
    expect(result.code, result.stderr).toBe(0)
    expect(parseRuntimePath(result.stdout)).toBe(f.executable)
    const probe = await run(probeRelayBunRuntimeCommand(host, f.executable, expectedHash))
    expect(parseRuntimePath(probe.stdout)).toBe(f.executable)
    expect(await readFile(f.executable, 'utf8')).toBe(content)
  })
  it('does not publish bytes with a different checksum', async () => {
    const f = await fixture()
    await writeFile(f.source, 'corrupt')
    const result = await run(promoteRelayBunRuntimeCommand(f))
    expect(result.code).not.toBe(0)
    await expect(readFile(f.executable)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('keeps a corrupt old executable and publishes a separate repair', async () => {
    const f = await fixture()
    await mkdir(join(f.directory, 'cache'))
    await writeFile(f.executable, 'old executable')
    const result = await run(promoteRelayBunRuntimeCommand(f))
    expect(result.code, result.stderr).toBe(0)
    const repair = parseRuntimePath(result.stdout)
    expect(repair).toBe(join(f.directory, 'cache', `repair-${f.repairToken}`, 'bun'))
    expect(await readFile(f.executable, 'utf8')).toBe('old executable')
    const reconnect = await run(probeRelayBunRuntimeCommand(host, f.executable, expectedHash))
    expect(reconnect.code, reconnect.stderr).toBe(0)
    expect(parseRuntimePath(reconnect.stdout)).toBe(repair)
  })
  it('rejects a recorded repair whose executable is damaged', async () => {
    const f = await fixture()
    await mkdir(join(f.directory, 'cache'))
    await writeFile(f.executable, 'corrupt primary')
    const published = await run(promoteRelayBunRuntimeCommand(f))
    const repair = parseRuntimePath(published.stdout)
    if (!repair) {
      throw new Error('Missing repair')
    }
    await writeFile(repair, 'corrupt repair')
    const probe = await run(probeRelayBunRuntimeCommand(host, f.executable, expectedHash))
    expect(parseRuntimePath(probe.stdout)).toBeUndefined()
  })
  it.each(['../../upload', 'repair-not-hex', `repair-${'a'.repeat(200)}`])(
    'does not follow an invalid repair reference: %s',
    async (reference) => {
      const f = await fixture()
      await mkdir(join(f.directory, 'cache'))
      await writeFile(join(f.directory, 'cache', '.current-repair'), reference)
      const probe = await run(probeRelayBunRuntimeCommand(host, f.executable, expectedHash))
      expect(parseRuntimePath(probe.stdout)).toBeUndefined()
    }
  )
  it('leaves a reusable verified repair after concurrent repair publication', async () => {
    const f = await fixture()
    await mkdir(join(f.directory, 'cache'))
    await writeFile(f.executable, 'corrupt primary')
    const otherSource = join(f.directory, 'upload', 'other-bun')
    await writeFile(otherSource, content)
    const results = await Promise.all([
      run(promoteRelayBunRuntimeCommand(f)),
      run(promoteRelayBunRuntimeCommand({ ...f, source: otherSource, repairToken: 'b'.repeat(24) }))
    ])
    for (const result of results) {
      expect(result.code, result.stderr).toBe(0)
    }
    const probe = await run(probeRelayBunRuntimeCommand(host, f.executable, expectedHash))
    const repair = parseRuntimePath(probe.stdout)
    expect(results.map((result) => parseRuntimePath(result.stdout))).toContain(repair)
    if (!repair) {
      throw new Error('Missing repair')
    }
    expect(await readFile(repair, 'utf8')).toBe(content)
    expect(await readFile(f.executable, 'utf8')).toBe('corrupt primary')
  })
  it.skipIf(windows)('does not trust or replace a symlinked cache entry', async () => {
    const f = await fixture()
    await mkdir(join(f.directory, 'cache'))
    await symlink(f.source, f.executable)
    const probe = await run(probeRelayBunRuntimeCommand(host, f.executable, expectedHash))
    expect(parseRuntimePath(probe.stdout)).toBeUndefined()
    const result = await run(promoteRelayBunRuntimeCommand(f))
    expect(result.code, result.stderr).toBe(0)
    expect(parseRuntimePath(result.stdout)).not.toBe(f.executable)
  })
  it('does not follow a repair reference through a symlinked directory', async () => {
    const f = await fixture()
    await mkdir(join(f.directory, 'cache'))
    await symlink(
      join(f.directory, 'upload'),
      join(f.directory, 'cache', `repair-${f.repairToken}`),
      windows ? 'junction' : 'dir'
    )
    await writeFile(join(f.directory, 'cache', '.current-repair'), `repair-${f.repairToken}`)
    const probe = await run(probeRelayBunRuntimeCommand(host, f.executable, expectedHash))
    expect(probe.code, probe.stderr).toBe(0)
    expect(parseRuntimePath(probe.stdout)).toBeUndefined()
    expect(await readFile(f.source, 'utf8')).toBe(content)
  })
  it('concurrent publishers reuse the same verified executable', async () => {
    const f = await fixture()
    const otherSource = join(f.directory, 'upload', 'other-bun')
    await writeFile(otherSource, content)
    const results = await Promise.all([
      run(promoteRelayBunRuntimeCommand(f)),
      run(promoteRelayBunRuntimeCommand({ ...f, source: otherSource, repairToken: 'b'.repeat(24) }))
    ])
    for (const result of results) {
      expect(result.code, result.stderr).toBe(0)
      expect(parseRuntimePath(result.stdout)).toBe(f.executable)
    }
  })
})

it('uses built-in Windows hashing and non-overwriting publication', () => {
  const script = decodeRemotePowerShellScript(
    promoteRelayBunRuntimeCommand({
      host: getRemoteHostPlatform('win32-x64'),
      source: 'C:/stage/bun.exe',
      executable: 'C:/cache/bun.exe',
      expectedHash,
      repairToken: 'a'.repeat(24)
    })
  )
  expect(script).toContain('[Security.Cryptography.SHA256]::Create()')
  expect(script).toContain('[IO.File]::Move($source, $file)')
  expect(script).not.toContain('node.exe')
  expect(script).not.toContain('Add-Type')
})
