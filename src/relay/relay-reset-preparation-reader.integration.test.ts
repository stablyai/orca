import { build } from 'esbuild'
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { runProcess } from '../shared/child-process/run-process'
import { RelayOwnerResetPreparationJournal } from './relay-owner-reset-preparation-journal'
import { RELAY_RESET_PREPARATION_READ_FLAG } from './relay-reset-preparation-reader'

let directory: string
let entry: string
let emptyPath: string
let envelope: object
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'orca-reset-reader-bundle-'))
  entry = join(directory, 'relay.js')
  emptyPath = join(directory, 'empty-path')
  mkdirSync(emptyPath)
  const journal = new RelayOwnerResetPreparationJournal(
    join(directory, 'journal'),
    join(directory, 'never-created.sock'),
    'old-build'
  )
  const request = {
    version: 1 as const,
    operationId: 'reset',
    runtimeIncarnation: 'exited-daemon',
    ownerGeneration: 1,
    ownerLease: 'private-lease'
  }
  journal.persist(request, 'owner', 'endpoint-credential', () => {})
  envelope = { version: 1, binding: journal.describe('owner', 'endpoint-credential'), request }
  await build({
    entryPoints: [join(__dirname, 'relay.ts')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile: entry,
    external: ['node-pty', '@parcel/watcher', 'electron'],
    sourcemap: false
  })
}, 30_000)
afterAll(() => {
  if (directory) {
    rmSync(directory, { recursive: true, force: true })
  }
})

const runtimes = [
  { label: 'Node', program: process.execPath },
  ...(process.env.BUN_EXECUTABLE ? [{ label: 'Bun', program: process.env.BUN_EXECUTABLE }] : [])
]

describe.each(runtimes)('$label built reader', ({ label, program }) => {
  it('reads retained evidence in a fresh process with an empty PATH and no daemon artifacts', async () => {
    if (label === 'Bun') {
      const version = await runProcess({ program, args: ['--version'] })
      const match = /^(\d+)\.(\d+)\./.exec(version.stdout.trim())
      expect(version.code).toBe(0)
      expect(
        match && (Number(match[1]) > 1 || (Number(match[1]) === 1 && Number(match[2]) >= 4))
      ).toBeTruthy()
    }
    const before = readdirSync(directory).sort()
    const result = await runProcess({
      program,
      args: [entry, RELAY_RESET_PREPARATION_READ_FLAG],
      cwd: directory,
      input: JSON.stringify(envelope),
      timeoutMs: 15_000,
      maxOutputBytes: 128 * 1024,
      env: {
        ...process.env,
        PATH: emptyPath,
        NODE_PATH: '',
        NODE_OPTIONS: '',
        ORCA_BACKGROUND_LAUNCH: '1'
      }
    })
    expect(result.timedOut).toBe(false)
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      version: 1,
      preparation: {
        prepared: true,
        serverBuildId: 'old-build',
        request: { runtimeIncarnation: 'exited-daemon' }
      }
    })
    expect(readdirSync(directory).sort()).toEqual(before)
  }, 20_000)

  it('rejects mixed launch modes without starting a daemon', async () => {
    const before = readdirSync(directory).sort()
    const result = await runProcess({
      program,
      args: [entry, '--detached', RELAY_RESET_PREPARATION_READ_FLAG],
      cwd: directory,
      input: JSON.stringify(envelope),
      timeoutMs: 15_000,
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
    })
    expect(result.timedOut).toBe(false)
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('arguments_invalid')
    expect(readdirSync(directory).sort()).toEqual(before)
  }, 20_000)
})
