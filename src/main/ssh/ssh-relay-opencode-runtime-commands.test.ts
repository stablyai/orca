import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
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
  publishOpenCodeRuntimeReferenceCommand
} from './ssh-relay-opencode-runtime-commands'
import {
  cleanupOwnedRelayUploadStageCommand,
  parseReservedRelayUploadStage,
  recoverOneStaleRelayUploadStageCommand,
  reserveRelayUploadStageCommand
} from './ssh-relay-upload-stage-commands'

const host = getRemoteHostPlatform('linux-x64')
const nodePath = process.execPath
const directories: string[] = []
const expectedHash = createHash('sha256').update('verified runtime').digest('hex')
const markerName = '.sftp-namespace-0123456789abcdef0123456789abcdef'

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

async function command(text: string, environment: NodeJS.ProcessEnv = {}) {
  return runProcess({
    program: 'sh',
    args: ['-c', text],
    timeoutMs: 10_000,
    env: { ...process.env, OPENCODE_DB: '', XDG_DATA_HOME: '', ...environment }
  })
}

async function reserveStage(root: string) {
  const pool = join(root, '.upload-stages')
  const result = await command(reserveRelayUploadStageCommand(host, pool, markerName))
  expect(result.code, result.stderr).toBe(0)
  return parseReservedRelayUploadStage(host, pool, markerName, result.stdout)
}

describe.skipIf(process.platform === 'win32')('host-owned SQLite setup commands', () => {
  it('runs an actual SQLite read and identifies the executable', async () => {
    const home = await directory()
    const data = join(home, '.local', 'share', 'opencode')
    await mkdir(data, { recursive: true })
    await writeFile(join(data, 'opencode.db'), '')
    const result = await command(probeOpenCodeNodeSqliteCommand(host, nodePath, home))
    expect(result.code).toBe(0)
    expect(parseOpenCodeRuntimeResult(result.stdout)).toEqual({
      status: 'ready',
      executable: nodePath
    })
  })

  it('stages, verifies by bytes, promotes and atomically publishes under quoted paths', async () => {
    const root = await directory()
    const stage = await reserveStage(root)
    const stageDir = stage.slotDir
    const executable = join(root, expectedHash, 'bun')
    const prepared = await command(
      prepareOpenCodeRuntimeStageCommand({
        host,
        nodePath,
        stageDir,
        markerName,
        executable,
        expectedHash
      })
    )
    expect(parseOpenCodeRuntimeResult(prepared.stdout).status).toBe('staged')
    expect((await stat(join(stageDir, markerName))).isFile()).toBe(true)
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
    await command(cleanupOwnedRelayUploadStageCommand(host, stage, markerName))
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
    const stage = await reserveStage(root)
    const prepared = await command(
      prepareOpenCodeRuntimeStageCommand({
        host,
        nodePath,
        stageDir: stage.slotDir,
        markerName,
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

  it('defers an empty host, honors database overrides, and ignores in-memory databases', async () => {
    const home = await directory()
    const probe = probeOpenCodeNodeSqliteCommand(host, nodePath, home)
    expect(parseOpenCodeRuntimeResult((await command(probe)).stdout).status).toBe('not-needed')
    const xdg = join(home, 'other data')
    await mkdir(join(xdg, 'opencode'), { recursive: true })
    await writeFile(join(xdg, 'opencode', 'opencode-team.db'), '')
    const environment = { XDG_DATA_HOME: xdg, OPENCODE_DB: 'opencode-team.db' }
    expect(parseOpenCodeRuntimeResult((await command(probe, environment)).stdout).status).toBe(
      'ready'
    )
    expect(
      parseOpenCodeRuntimeResult(
        (await command(probe, { ...environment, OPENCODE_DB: ':memory:' })).stdout
      ).status
    ).toBe('not-needed')
  })

  it('reclaims an abandoned binary through the shared pool while preserving fresh uploads', async () => {
    const root = await directory()
    const abandoned = await reserveStage(root)
    await writeFile(join(abandoned.slotDir, 'payload', 'bun'), 'partial upload')
    const fresh = await reserveStage(root)
    await writeFile(join(fresh.slotDir, 'payload', 'bun'), 'active upload')
    const old = new Date(Date.now() - 3_600_000)
    await utimes(join(abandoned.slotDir, '.orca-upload-owner'), old, old)
    const recovered = await command(recoverOneStaleRelayUploadStageCommand(host, abandoned.poolDir))
    expect(recovered.code, recovered.stderr).toBe(0)
    await expect(stat(abandoned.slotDir)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(fresh.slotDir, 'payload', 'bun'), 'utf8')).toBe('active upload')
  })

  it('falls back to an atomic unique rename when the host filesystem rejects hard links', async () => {
    const root = await directory()
    const source = join(root, 'source')
    await writeFile(source, 'verified runtime')
    const preload = join(root, 'disable-hardlinks.cjs')
    await writeFile(
      preload,
      "require('node:fs').promises.link=async()=>{throw Object.assign(Error('unsupported'),{code:'EPERM'})}"
    )
    const executable = join(root, expectedHash, 'bun')
    const result = await command(
      promoteOpenCodeRuntimeCommand({
        host,
        nodePath,
        stagedBinary: source,
        executable,
        expectedHash,
        repairToken: 'fallback'
      }),
      { NODE_OPTIONS: `--require ${JSON.stringify(preload)}` }
    )
    expect(result.code, result.stderr).toBe(0)
    const repaired = join(root, expectedHash, 'repair-fallback', 'bun')
    expect(parseOpenCodeRuntimeResult(result.stdout)).toEqual({
      status: 'ready',
      executable: repaired
    })
    expect(await readFile(repaired, 'utf8')).toBe('verified runtime')
    await expect(stat(source)).rejects.toMatchObject({ code: 'ENOENT' })
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

it('accepts an absolute Windows UNC executable path', () => {
  const executable = String.raw`\\server\profile\vault-sqlite\bun.exe`
  expect(
    parseOpenCodeRuntimeResult(
      `ORCA_VAULT_SQLITE:${JSON.stringify({ status: 'ready', executable })}`
    )
  ).toEqual({ status: 'ready', executable })
})
