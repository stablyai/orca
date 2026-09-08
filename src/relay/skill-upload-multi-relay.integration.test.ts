import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { spawnRelay, type RelayProcess } from './subprocess-test-utils'

let bundleRoot: string
let relayEntry: string
const relays: RelayProcess[] = []
const roots: string[] = []

beforeAll(async () => {
  const externalEntry = process.env.ORCA_SKILL_UPLOAD_RELAY_ENTRY
  if (externalEntry) {
    relayEntry = resolve(externalEntry)
    return
  }
  bundleRoot = await mkdtemp(join(tmpdir(), 'orca-skill-multi-relay-bundle-'))
  relayEntry = join(bundleRoot, 'relay.js')
  await build({
    entryPoints: [resolve('src/relay/relay.ts')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile: relayEntry,
    external: ['node-pty', '@parcel/watcher', 'electron'],
    logLevel: 'silent'
  })
})

afterAll(async () => {
  if (bundleRoot) {
    await rm(bundleRoot, { recursive: true, force: true })
  }
})

afterEach(async () => {
  await Promise.all(
    relays.splice(0).map(async (relay) => {
      relay.kill('SIGTERM')
      await relay.waitForExit().catch(() => undefined)
    })
  )
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function request(
  relay: RelayProcess,
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  const response = await relay.waitForResponse(relay.send(method, params))
  expect(response.error).toBeUndefined()
  return response.result
}

async function stagedArchives(uploadRoot: string): Promise<string[]> {
  const entries = await readdir(uploadRoot, { withFileTypes: true })
  const rootArchives = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.tar.gz'))
    .map((entry) => join(uploadRoot, entry.name))
  const archives = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) =>
        (await readdir(join(uploadRoot, entry.name)))
          .filter((name) => name.endsWith('.tar.gz'))
          .map((name) => join(uploadRoot, entry.name, name))
      )
  )
  return [...rootArchives, ...archives.flat()].sort()
}

async function uploadRootForOracle(home: string): Promise<string> {
  const installRoot = join(home, '.orca', 'skill-installs')
  const current = join(installRoot, 'remote-uploads-v2')
  return (await stat(current).catch(() => null)) ? current : join(installRoot, 'remote-uploads')
}

function packageIdentity(bytes: Buffer, suffix: string) {
  return {
    packageId: `package_${suffix}`,
    versionId: `version_${suffix}`,
    packageDigest: createHash('sha256').update(`manifest-${suffix}`).digest('hex'),
    archiveSha256: createHash('sha256').update(bytes).digest('hex'),
    compressedBytes: bytes.length
  }
}

describe('skill upload ownership across relay processes', () => {
  it('keeps each live relay upload isolated and cleans each exact owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-multi-relay-'))
    roots.push(root)
    const home = join(root, 'home')
    const environment = { ...process.env, HOME: home, USERPROFILE: home }
    const first = spawnRelay(
      relayEntry,
      ['--sock-path', join(root, 'first.sock'), '--endpoint-dir', join(root, 'first-hooks')],
      { env: environment }
    )
    const second = spawnRelay(
      relayEntry,
      ['--sock-path', join(root, 'second.sock'), '--endpoint-dir', join(root, 'second-hooks')],
      { env: environment }
    )
    relays.push(first, second)
    await Promise.all([first.sentinelReceived, second.sentinelReceived])
    const firstBytes = Buffer.from('first relay live upload')
    const secondBytes = Buffer.from('second relay upload')
    const firstUpload = (await request(first, 'skills.beginUpload', {
      package: packageIdentity(firstBytes, 'first')
    })) as { uploadId: string }
    await request(first, 'skills.uploadChunk', {
      uploadId: firstUpload.uploadId,
      offset: 0,
      bytesBase64: firstBytes.subarray(0, 5).toString('base64')
    })

    const secondUpload = (await request(second, 'skills.beginUpload', {
      package: packageIdentity(secondBytes, 'second')
    })) as { uploadId: string }
    await request(second, 'skills.uploadChunk', {
      uploadId: secondUpload.uploadId,
      offset: 0,
      bytesBase64: secondBytes.toString('base64')
    })
    const uploadRoot = await uploadRootForOracle(home)
    const ownerEntries = (await readdir(uploadRoot, { withFileTypes: true })).filter((entry) =>
      entry.isDirectory()
    )
    const archives = await stagedArchives(uploadRoot)
    const firstPath = archives.find((path) => path.endsWith(`${firstUpload.uploadId}.tar.gz`))
    const secondPath = archives.find((path) => path.endsWith(`${secondUpload.uploadId}.tar.gz`))
    const firstStagedBytes = firstPath ? await readFile(firstPath) : null
    const secondStagedBytes = secondPath ? await readFile(secondPath) : null
    const ownerPattern = /^owner-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

    expect.soft(ownerEntries).toHaveLength(2)
    expect.soft(ownerEntries.every((entry) => ownerPattern.test(entry.name))).toBe(true)
    expect
      .soft(ownerEntries.some((entry) => entry.name.startsWith(`owner-${first.proc.pid}-`)))
      .toBe(true)
    expect
      .soft(ownerEntries.some((entry) => entry.name.startsWith(`owner-${second.proc.pid}-`)))
      .toBe(true)
    expect.soft(archives).toHaveLength(2)
    expect.soft(basename(dirname(firstPath!))).toMatch(new RegExp(`^owner-${first.proc.pid}-`))
    expect.soft(basename(dirname(secondPath!))).toMatch(new RegExp(`^owner-${second.proc.pid}-`))
    expect.soft(firstStagedBytes).toEqual(firstBytes.subarray(0, 5))
    expect.soft(secondStagedBytes).toEqual(secondBytes)
    await request(second, 'skills.cancelUpload', { uploadId: secondUpload.uploadId })
    expect(await stagedArchives(uploadRoot)).toEqual([firstPath])
    await request(first, 'skills.cancelUpload', { uploadId: firstUpload.uploadId })
    expect(await stagedArchives(uploadRoot)).toEqual([])

    const firstDisposalBytes = Buffer.from('first relay disposal upload')
    const secondDisposalBytes = Buffer.from('second relay disposal upload')
    const firstDisposalUpload = (await request(first, 'skills.beginUpload', {
      package: packageIdentity(firstDisposalBytes, 'first_disposal')
    })) as { uploadId: string }
    await request(first, 'skills.uploadChunk', {
      uploadId: firstDisposalUpload.uploadId,
      offset: 0,
      bytesBase64: firstDisposalBytes.toString('base64')
    })
    const secondDisposalUpload = (await request(second, 'skills.beginUpload', {
      package: packageIdentity(secondDisposalBytes, 'second_disposal')
    })) as { uploadId: string }
    await request(second, 'skills.uploadChunk', {
      uploadId: secondDisposalUpload.uploadId,
      offset: 0,
      bytesBase64: secondDisposalBytes.toString('base64')
    })
    const disposalArchives = await stagedArchives(uploadRoot)
    const secondDisposalPath = disposalArchives.find((path) =>
      path.endsWith(`${secondDisposalUpload.uploadId}.tar.gz`)
    )

    first.kill('SIGTERM')
    await first.waitForExit()
    relays.splice(relays.indexOf(first), 1)
    expect(await readdir(uploadRoot)).toEqual([
      expect.stringMatching(new RegExp(`^owner-${second.proc.pid}-`))
    ])
    expect(await stagedArchives(uploadRoot)).toEqual([secondDisposalPath])
    await expect(readFile(secondDisposalPath!)).resolves.toEqual(secondDisposalBytes)
    second.kill('SIGTERM')
    await second.waitForExit()
    relays.splice(relays.indexOf(second), 1)
    expect(await readdir(uploadRoot)).toEqual([])
  })

  it
    .runIf(Boolean(process.env.ORCA_SKILL_UPLOAD_LEGACY_RELAY_ENTRY))
    .each(['legacy-first', 'current-first'] as const)(
    'keeps %s mixed-version uploads isolated',
    async (order) => {
      const root = await mkdtemp(join(tmpdir(), 'orca-skill-mixed-relay-'))
      roots.push(root)
      const home = join(root, 'home')
      const environment = { ...process.env, HOME: home, USERPROFILE: home }
      const legacyEntry = resolve(process.env.ORCA_SKILL_UPLOAD_LEGACY_RELAY_ENTRY!)
      const entries =
        order === 'legacy-first'
          ? [
              { kind: 'legacy', entry: legacyEntry },
              { kind: 'current', entry: relayEntry }
            ]
          : [
              { kind: 'current', entry: relayEntry },
              { kind: 'legacy', entry: legacyEntry }
            ]
      const uploads: { relay: RelayProcess; uploadId: string; bytes: Buffer; kind: string }[] = []
      for (const [index, owner] of entries.entries()) {
        const relay = spawnRelay(
          owner.entry,
          [
            '--sock-path',
            join(root, `${owner.kind}.sock`),
            '--endpoint-dir',
            join(root, `${owner.kind}-hooks`)
          ],
          { env: environment }
        )
        relays.push(relay)
        await relay.sentinelReceived
        const bytes = Buffer.from(`${owner.kind} live upload`)
        const begun = (await request(relay, 'skills.beginUpload', {
          package: packageIdentity(bytes, `${owner.kind}_${index}`)
        })) as { uploadId: string }
        await request(relay, 'skills.uploadChunk', {
          uploadId: begun.uploadId,
          offset: 0,
          bytesBase64: bytes.toString('base64')
        })
        uploads.push({ relay, uploadId: begun.uploadId, bytes, kind: owner.kind })
      }

      const installRoot = join(home, '.orca', 'skill-installs')
      const legacyFiles = (await readdir(join(installRoot, 'remote-uploads'))).filter((name) =>
        name.endsWith('.tar.gz')
      )
      const currentFiles = await stagedArchives(join(installRoot, 'remote-uploads-v2'))
      expect(legacyFiles).toHaveLength(1)
      expect(currentFiles).toHaveLength(1)
      for (const upload of uploads) {
        const path =
          upload.kind === 'legacy'
            ? join(installRoot, 'remote-uploads', legacyFiles[0]!)
            : currentFiles[0]!
        await expect(readFile(path)).resolves.toEqual(upload.bytes)
        await request(upload.relay, 'skills.cancelUpload', { uploadId: upload.uploadId })
      }
    }
  )
})
