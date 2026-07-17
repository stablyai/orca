import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  executeSshRelayRuntimeReadbackArchive,
  executeSshRelayRuntimeReadbackArchiveFromPaths,
  parseSshRelayRuntimeReadbackArchiveExecutionArguments
} from './ssh-relay-runtime-readback-archive-execution.mjs'

const ARCHIVE_NAME = 'orca-ssh-relay-runtime-v1-linux-x64-glibc-a.tar.br'
const ARCHIVE_BYTES = Buffer.from('verified materialized archive bytes')
const ARCHIVE_SHA256 = `sha256:${createHash('sha256').update(ARCHIVE_BYTES).digest('hex')}`

let root
let archivePath

function identity() {
  return {
    tupleId: 'linux-x64-glibc',
    contentId: `sha256:${'a'.repeat(64)}`,
    archive: {
      name: ARCHIVE_NAME,
      sha256: ARCHIVE_SHA256,
      size: ARCHIVE_BYTES.length
    }
  }
}

function materializedArchive(overrides = {}) {
  return {
    name: ARCHIVE_NAME,
    path: archivePath,
    sha256: ARCHIVE_SHA256,
    size: ARCHIVE_BYTES.length,
    ...overrides
  }
}

function input(overrides = {}) {
  return {
    identity: identity(),
    materializedArchive: materializedArchive(),
    outputDirectory: join(root, 'executed-runtime'),
    ...overrides
  }
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'orca-relay-readback-execution-')))
  archivePath = join(root, ARCHIVE_NAME)
  await writeFile(archivePath, ARCHIVE_BYTES)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('SSH relay runtime read-back archive execution', () => {
  it('runs real archives in all three native job families without release or consumer wiring', async () => {
    const workflow = await readFile(
      resolve(import.meta.dirname, '../../.github/workflows/ssh-relay-runtime-artifacts.yml'),
      'utf8'
    )

    expect(workflow.match(/exercise only local verified bytes/g)).toHaveLength(3)
    expect(workflow.match(/--output-directory "\$executed_runtime"/g)).toHaveLength(2)
    expect(workflow.match(/--output-directory \$executedRuntime/g)).toHaveLength(1)
    expect(workflow).toContain('docker run --rm --network none --read-only --cap-drop all')
    expect(workflow).toContain('rm -rf -- "$executed_runtime"')
    expect(workflow).toContain('Remove-Item -LiteralPath $executedRuntime -Recurse -Force')
    for (const tuple of [
      'linux-x64-glibc',
      'linux-arm64-glibc',
      'darwin-x64',
      'darwin-arm64',
      'win32-x64',
      'win32-arm64'
    ]) {
      expect(workflow).toContain(`tuple: ${tuple}`)
    }
    expect(workflow).not.toMatch(/ssh-relay-runtime-readback-archive-execution[^\n]*publish/)
  })

  it('requires exact resolved inputs for the disconnected native-runner rehearsal', () => {
    expect(
      parseSshRelayRuntimeReadbackArchiveExecutionArguments([
        '--identity',
        'runtime.identity.json',
        '--archive',
        ARCHIVE_NAME,
        '--output-directory',
        'reconstructed-runtime'
      ])
    ).toEqual({
      identityPath: resolve('runtime.identity.json'),
      archivePath: resolve(ARCHIVE_NAME),
      outputDirectory: resolve('reconstructed-runtime')
    })
    expect(() =>
      parseSshRelayRuntimeReadbackArchiveExecutionArguments([
        '--identity',
        'runtime.identity.json',
        '--archive',
        ARCHIVE_NAME
      ])
    ).toThrow(/requires identity, archive, and output/i)
  })

  it('canonicalizes a runner temp alias before entering the physical-path boundary', async () => {
    const alias = join(root, 'runner-temp-alias')
    await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const identityPath = join(root, 'runtime.identity.json')
    await writeFile(identityPath, JSON.stringify(identity()))
    const outputDirectory = join(root, 'alias-executed-runtime')
    const extractImpl = vi.fn(async ({ archivePath: candidate }) => {
      expect(candidate).toBe(archivePath)
      await mkdir(outputDirectory)
      return {
        tupleId: identity().tupleId,
        runtimeRoot: outputDirectory,
        tree: { contentId: identity().contentId }
      }
    })
    const verifyImpl = vi.fn(async () => ({
      tuple: identity().tupleId,
      tree: { contentId: identity().contentId },
      smoke: { nodeVersion: 'v24.18.0' },
      durationMs: 8
    }))

    await expect(
      executeSshRelayRuntimeReadbackArchiveFromPaths({
        identityPath,
        archivePath: join(alias, ARCHIVE_NAME),
        outputDirectory,
        extractImpl,
        verifyImpl
      })
    ).resolves.toMatchObject({
      archive: { path: archivePath },
      runtimeRoot: outputDirectory
    })
  })

  it('extracts the exact materialized archive before bundled runtime smoke', async () => {
    const order = []
    const outputDirectory = join(root, 'executed-runtime')
    const extractImpl = vi.fn(async (options) => {
      order.push('extract')
      expect(options).toMatchObject({ archivePath, outputDirectory, identity: identity() })
      await mkdir(outputDirectory)
      return {
        tupleId: identity().tupleId,
        runtimeRoot: outputDirectory,
        tree: { contentId: identity().contentId }
      }
    })
    const verifyImpl = vi.fn(async (options) => {
      order.push('verify-and-smoke')
      expect(options).toMatchObject({
        archivePath,
        runtimeDirectory: outputDirectory,
        identity: identity()
      })
      return {
        tuple: identity().tupleId,
        tree: { contentId: identity().contentId },
        smoke: { nodeVersion: 'v24.18.0' },
        durationMs: 12
      }
    })

    await expect(
      executeSshRelayRuntimeReadbackArchive(input({ extractImpl, verifyImpl, outputDirectory }))
    ).resolves.toEqual({
      tupleId: identity().tupleId,
      contentId: identity().contentId,
      archive: materializedArchive(),
      runtimeRoot: outputDirectory,
      tree: { contentId: identity().contentId },
      smoke: { nodeVersion: 'v24.18.0' },
      durationMs: 12
    })
    expect(order).toEqual(['extract', 'verify-and-smoke'])
  })

  it.each([
    ['unexpected fields', { extra: true }],
    ['archive name', { name: `${ARCHIVE_NAME}.changed` }],
    ['archive digest', { sha256: `sha256:${'b'.repeat(64)}` }],
    ['archive size', { size: ARCHIVE_BYTES.length + 1 }],
    ['physical absolute path', { path: ARCHIVE_NAME }]
  ])('rejects materialized %s drift before extraction', async (_label, changed) => {
    const extractImpl = vi.fn()

    await expect(
      executeSshRelayRuntimeReadbackArchive(
        input({ materializedArchive: materializedArchive(changed), extractImpl })
      )
    ).rejects.toThrow(/materialized|archive|path|field|identity/i)
    expect(extractImpl).not.toHaveBeenCalled()
  })

  it('removes the extracted runtime after smoke, cancellation, or result-identity failure', async () => {
    for (const failure of ['smoke', 'cancel', 'identity']) {
      const outputDirectory = join(root, `failed-${failure}`)
      const controller = new AbortController()
      const extractImpl = vi.fn(async () => {
        await mkdir(outputDirectory)
        return {
          tupleId: identity().tupleId,
          runtimeRoot: outputDirectory,
          tree: { contentId: identity().contentId }
        }
      })
      const verifyImpl = vi.fn(async () => {
        if (failure === 'cancel') {
          controller.abort(new Error('cancel archive execution'))
          controller.signal.throwIfAborted()
        }
        if (failure === 'smoke') {
          throw new Error('bundled watcher smoke failed')
        }
        return {
          tuple: 'darwin-arm64',
          tree: { contentId: identity().contentId },
          smoke: {},
          durationMs: 1
        }
      })

      await expect(
        executeSshRelayRuntimeReadbackArchive(
          input({ outputDirectory, extractImpl, verifyImpl, signal: controller.signal })
        )
      ).rejects.toThrow(/smoke|cancel|identity/i)
      await expect(readdir(outputDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })
})
