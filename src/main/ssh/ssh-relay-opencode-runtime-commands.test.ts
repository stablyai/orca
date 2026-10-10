import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import { decodeRemotePowerShellScript } from './ssh-remote-powershell'
import {
  parseOpenCodeRuntimeResult,
  probeOpenCodeNodeSqliteCommand,
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
const runtimeSha = 'a'.repeat(64)
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

  it('sends a host Node without the SyncDatabase surface to the pinned runtime', async () => {
    const home = await directory()
    const data = join(home, '.local', 'share', 'opencode')
    await mkdir(data, { recursive: true })
    await writeFile(join(data, 'opencode.db'), '')
    // Node 22.13-22.15: DatabaseSync ships, the backup export does not.
    const preload = join(home, 'node-22-13-sqlite.cjs')
    await writeFile(preload, "delete require('node:sqlite').backup")
    const result = await command(probeOpenCodeNodeSqliteCommand(host, nodePath, home), {
      NODE_OPTIONS: `--require ${JSON.stringify(preload)}`
    })
    expect(result.code, result.stderr).toBe(0)
    expect(parseOpenCodeRuntimeResult(result.stdout)).toEqual({ status: 'unsupported' })
  })

  it('ignores the experimental SQLite warning older Node prints to stderr', async () => {
    const home = await directory()
    const data = join(home, '.local', 'share', 'opencode')
    await mkdir(data, { recursive: true })
    await writeFile(join(data, 'opencode.db'), '')
    const preload = join(home, 'experimental-warning.cjs')
    await writeFile(
      preload,
      "process.emitWarning('SQLite is an experimental feature and might change at any time','ExperimentalWarning')"
    )
    const result = await command(probeOpenCodeNodeSqliteCommand(host, nodePath, home), {
      NODE_OPTIONS: `--require ${JSON.stringify(preload)}`
    })
    expect(result.stderr).toContain('ExperimentalWarning')
    expect(parseOpenCodeRuntimeResult(result.stdout)).toEqual({
      status: 'ready',
      executable: nodePath
    })
  })

  it('publishes the reference atomically through a staged file under quoted paths', async () => {
    const root = await directory()
    const stage = await reserveStage(root)
    const executable = join(root, 'runtimes', `node-${runtimeSha}`, 'bin', 'node')
    const reference = join(root, 'opencode-sqlite-runtime.json')
    await writeFile(reference, '{"old":true}')
    const stagedReference = join(stage.slotDir, 'payload', 'ref.json')
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
    await expect(stat(join(root, `.runtime-ref-node-${runtimeSha}`))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await command(cleanupOwnedRelayUploadStageCommand(host, stage, markerName))
    await expect(stat(stage.slotDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('writes the store ref that holds a pinned runtime before the reference names it', async () => {
    const root = await directory()
    const stagedReference = join(root, 'staged.json')
    await writeFile(stagedReference, '{"protocol":1}')
    const ref = join(root, `.runtime-ref-node-${runtimeSha}`)
    const published = await command(
      publishOpenCodeRuntimeReferenceCommand({
        host,
        nodePath,
        stagedReference,
        reference: join(root, 'opencode-sqlite-runtime.json'),
        token: 'two',
        runtimeRef: { path: ref, sha256: runtimeSha }
      })
    )
    expect(parseOpenCodeRuntimeResult(published.stdout).status).toBe('published')
    expect(await readFile(ref, 'utf8')).toBe(`${runtimeSha}\n`)
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
})

it('carries Windows JavaScript and path arguments through the established PowerShell encoder', () => {
  const windows = getRemoteHostPlatform('win32-x64')
  const command = publishOpenCodeRuntimeReferenceCommand({
    host: windows,
    nodePath: "C:/Program Files/O'Brien/node.exe",
    stagedReference: 'C:/Users/a & b/.upload/ref.json',
    reference: 'C:/Users/a & b/.orca-remote/relay-x/opencode-sqlite-runtime.json',
    token: 'one',
    runtimeRef: {
      path: `C:/Users/a & b/.orca-remote/relay-x/.runtime-ref-node-${runtimeSha}`,
      sha256: runtimeSha
    }
  })
  const decoded = decodeRemotePowerShellScript(command)
  expect(decoded).toContain("& 'C:/Program Files/O''Brien/node.exe'")
  expect(decoded).toContain('C:/Users/a & b/.upload/ref.json')
  expect(decoded).toContain(`.runtime-ref-node-${runtimeSha}`)
  expect(command).not.toContain('-ExecutionPolicy')
  expect(decoded).not.toContain('Add-Type')
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
