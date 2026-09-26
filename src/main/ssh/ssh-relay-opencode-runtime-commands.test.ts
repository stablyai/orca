import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import { decodeRemotePowerShellScript } from './ssh-remote-powershell'
import {
  parseOpenCodeRuntimeResult,
  prepareOpenCodeRuntimeStageCommand,
  probeOpenCodeNodeSqliteCommand,
  promoteOpenCodeRuntimeCommand,
  publishOpenCodeRuntimeReferenceCommand,
  removeOpenCodeRuntimeStageCommand
} from './ssh-relay-opencode-runtime-commands'

const host = getRemoteHostPlatform('linux-x64')
const nodePath = process.execPath
const directories: string[] = []
const expectedHash = createHash('sha256').update('verified runtime').digest('hex')

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

async function directory(): Promise<string> {
  const result = await mkdtemp(join(tmpdir(), "orca-runtime spaces ' $-"))
  directories.push(result)
  return result
}

async function command(text: string) {
  return runProcess({ program: 'sh', args: ['-c', text], timeoutMs: 10_000 })
}

describe.skipIf(process.platform === 'win32')('host-owned SQLite setup commands', () => {
  it('runs an actual SQLite read and identifies the executable', async () => {
    const result = await command(probeOpenCodeNodeSqliteCommand(host, nodePath))
    expect(result.code).toBe(0)
    expect(parseOpenCodeRuntimeResult(result.stdout)).toEqual({
      status: 'ready',
      executable: nodePath
    })
  })

  it('stages, verifies by bytes, promotes and atomically publishes under quoted paths', async () => {
    const root = await directory()
    const stageDir = join(root, '.upload')
    const executable = join(root, expectedHash, 'bun')
    const prepared = await command(
      prepareOpenCodeRuntimeStageCommand({
        host,
        nodePath,
        stageDir,
        markerName: '.marker',
        executable,
        expectedHash
      })
    )
    expect(parseOpenCodeRuntimeResult(prepared.stdout).status).toBe('staged')
    expect((await stat(join(stageDir, '.marker'))).isFile()).toBe(true)
    const stagedBinary = join(stageDir, 'payload', 'bun')
    await writeFile(stagedBinary, 'verified runtime')
    const promoted = await command(
      promoteOpenCodeRuntimeCommand({
        host,
        nodePath,
        stagedBinary,
        executable,
        expectedHash,
        repairToken: 'repair'
      })
    )
    expect(parseOpenCodeRuntimeResult(promoted.stdout)).toEqual({ status: 'ready', executable })
    expect(await readFile(executable, 'utf8')).toBe('verified runtime')
    const reference = join(root, 'opencode-sqlite-runtime.json')
    await writeFile(reference, '{"old":true}')
    const stagedReference = join(stageDir, 'payload', 'ref.json')
    await writeFile(stagedReference, JSON.stringify({ protocol: 1, executable }))
    const published = await command(
      publishOpenCodeRuntimeReferenceCommand({
        host,
        nodePath,
        stagedReference,
        reference,
        token: 'one'
      })
    )
    expect(parseOpenCodeRuntimeResult(published.stdout).status).toBe('published')
    expect(JSON.parse(await readFile(reference, 'utf8'))).toEqual({ protocol: 1, executable })
    await command(removeOpenCodeRuntimeStageCommand(host, nodePath, stageDir))
    await expect(stat(stageDir)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(executable, 'utf8')).toBe('verified runtime')
  })

  it('refuses equal-sized corrupt uploads instead of accepting a size match', async () => {
    const root = await directory()
    const stagedBinary = join(root, 'source')
    const executable = join(root, 'installed', 'bun')
    await writeFile(stagedBinary, 'corrupt! runtime')
    expect((await stat(stagedBinary)).size).toBe(Buffer.byteLength('verified runtime'))
    const result = await command(
      promoteOpenCodeRuntimeCommand({
        host,
        nodePath,
        stagedBinary,
        executable,
        expectedHash,
        repairToken: 'one'
      })
    )
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('checksum mismatch')
    await expect(stat(executable)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves an existing corrupt binary and reuses its verified repair reference', async () => {
    const root = await directory()
    const executable = join(root, expectedHash, 'bun')
    await mkdir(join(root, expectedHash))
    await writeFile(executable, 'old binary still owned by another process')
    const stagedBinary = join(root, 'source')
    await writeFile(stagedBinary, 'verified runtime')
    const promoted = await command(
      promoteOpenCodeRuntimeCommand({
        host,
        nodePath,
        stagedBinary,
        executable,
        expectedHash,
        repairToken: 'two'
      })
    )
    const repaired = join(root, expectedHash, 'repair-two', 'bun')
    expect(parseOpenCodeRuntimeResult(promoted.stdout).executable).toBe(repaired)
    expect(await readFile(executable, 'utf8')).toBe('old binary still owned by another process')
    const reference = join(root, 'runtime.json')
    await writeFile(reference, JSON.stringify({ protocol: 1, executable: repaired }))
    const prepared = await command(
      prepareOpenCodeRuntimeStageCommand({
        host,
        nodePath,
        stageDir: join(root, 'retry'),
        markerName: '.marker',
        executable,
        expectedHash,
        reference
      })
    )
    expect(parseOpenCodeRuntimeResult(prepared.stdout)).toEqual({
      status: 'ready',
      executable: repaired
    })
  })
})

it('carries Windows JavaScript and path arguments through the established PowerShell encoder', () => {
  const windows = getRemoteHostPlatform('win32-x64')
  const command = promoteOpenCodeRuntimeCommand({
    host: windows,
    nodePath: "C:/Program Files/O'Brien/node.exe",
    stagedBinary: 'C:/Users/a & b/.upload/bun.exe',
    executable: 'C:/Users/a & b/cache/bun.exe',
    expectedHash,
    repairToken: 'one'
  })
  const decoded = decodeRemotePowerShellScript(command)
  expect(decoded).toContain("& 'C:/Program Files/O''Brien/node.exe'")
  expect(decoded).toContain('createHash')
  expect(decoded).toContain('C:/Users/a & b/.upload/bun.exe')
  expect(command).not.toContain('-ExecutionPolicy')
})

it('rejects missing or malformed host confirmations', () => {
  expect(() => parseOpenCodeRuntimeResult('login banner')).toThrow('did not confirm')
  expect(() =>
    parseOpenCodeRuntimeResult('ORCA_VAULT_SQLITE:{"status":"ready","executable":"node"}')
  ).toThrow('invalid executable')
})
