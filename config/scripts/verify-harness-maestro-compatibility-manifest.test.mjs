import { createHash } from 'node:crypto'
import {
  cp,
  mkdtemp,
  readFile,
  readlink,
  rename,
  symlink,
  unlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const run = promisify(execFile)
const digest = 'f77f89ba3a9b7c0aef06850f58ef0eb2d2e1dca3e9ab7b609f1c6b7575468932'
const fixture = `tests/fixtures/harness-maestro-compatibility/sha256/${digest}/manifest.json`
const bundle = 'tests/fixtures/harness-maestro-compatibility'

async function copyFixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-manifest-'))
  const target = join(root, 'bundle')
  await cp(bundle, target, { recursive: true })
  return { root, target, manifest: join(target, 'sha256', digest, 'manifest.json') }
}

async function mutateManifest(mutator) {
  const copy = await copyFixture()
  const manifest = JSON.parse(await readFile(copy.manifest, 'utf8'))
  mutator(manifest)
  await writeFile(copy.manifest, JSON.stringify(manifest))
  return copy.manifest
}

describe('Harness Maestro compatibility verifier', () => {
  it('accepts the byte-preserved MLK-13 v1 exporter bundle', async () => {
    const result = await run('node', [
      'config/scripts/verify-harness-maestro-compatibility-manifest.mjs',
      '--manifest',
      fixture
    ])
    expect(result.stdout).toContain(`"manifestDigest":"sha256:${digest}"`)
  })

  it('rejects altered receipt bytes', async () => {
    const copy = await copyFixture()
    const receipt = join(copy.target, 'sha256', digest, 'receipts', 'MLK-05.json')
    await writeFile(receipt, `${await readFile(receipt, 'utf8')}\n`)
    await expect(
      run('node', [
        'config/scripts/verify-harness-maestro-compatibility-manifest.mjs',
        '--manifest',
        copy.manifest
      ])
    ).rejects.toBeTruthy()
  })

  it.each([
    [
      'traversal receipt paths',
      (manifest) => {
        manifest.receipts[0].path = '../MLK-05.json'
      }
    ],
    [
      'open manifest schemas',
      (manifest) => {
        manifest.unexpected = true
      }
    ],
    [
      'duplicate receipt identities',
      (manifest) => {
        manifest.receipts[1].task_id = 'MLK-05'
      }
    ],
    [
      'unsupported capability versions',
      (manifest) => {
        manifest.required_capabilities[0].version = 2
      }
    ],
    [
      'missing receipt pins',
      (manifest) => {
        delete manifest.receipts[0].path
      }
    ]
  ])('rejects %s', async (_name, mutate) => {
    await expect(
      run('node', [
        'config/scripts/verify-harness-maestro-compatibility-manifest.mjs',
        '--manifest',
        await mutateManifest(mutate)
      ])
    ).rejects.toBeTruthy()
  })

  it('rejects incomplete quarantine producer evidence', async () => {
    const copy = await copyFixture()
    const receipt = join(copy.target, 'sha256', digest, 'receipts', 'MLK-06Q.json')
    const value = JSON.parse(await readFile(receipt, 'utf8'))
    value.required_producers = value.required_producers.filter(
      (producer) => producer.task_id !== 'MLK-15'
    )
    await writeFile(receipt, JSON.stringify(value))
    await expect(
      run('node', [
        'config/scripts/verify-harness-maestro-compatibility-manifest.mjs',
        '--manifest',
        copy.manifest
      ])
    ).rejects.toBeTruthy()
  })

  it('rejects incomplete progress producer evidence', async () => {
    const copy = await copyFixture()
    const receipt = join(copy.target, 'sha256', digest, 'receipts', 'MLK-07P.json')
    const value = JSON.parse(await readFile(receipt, 'utf8'))
    value.required_producers = value.required_producers.filter(
      (producer) => producer.task_id !== 'MLK-19'
    )
    await writeFile(receipt, JSON.stringify(value))
    await expect(
      run('node', [
        'config/scripts/verify-harness-maestro-compatibility-manifest.mjs',
        '--manifest',
        copy.manifest
      ])
    ).rejects.toBeTruthy()
  })

  it('rejects symlinked receipt paths', async () => {
    const copy = await copyFixture()
    const receipt = join(copy.target, 'sha256', digest, 'receipts', 'MLK-05.json')
    const bytes = await readFile(receipt)
    await unlink(receipt)
    await symlink('/etc/hosts', receipt)
    await expect(
      run('node', [
        'config/scripts/verify-harness-maestro-compatibility-manifest.mjs',
        '--manifest',
        copy.manifest
      ])
    ).rejects.toBeTruthy()
    expect(await readlink(receipt)).toBe('/etc/hosts')
    expect(bytes.length).toBeGreaterThan(0)
  })

  it.each([
    ['positional arguments', [fixture]],
    ['missing manifest arguments', ['--manifest']],
    ['extra CLI arguments', ['--manifest', fixture, 'extra']]
  ])('rejects %s', async (_name, argumentsList) => {
    await expect(
      run('node', [
        'config/scripts/verify-harness-maestro-compatibility-manifest.mjs',
        ...argumentsList
      ])
    ).rejects.toBeTruthy()
  })

  it('rejects a distinct self-consistent content-addressed bundle', async () => {
    const copy = await copyFixture()
    const changed = JSON.parse(await readFile(copy.manifest, 'utf8'))
    changed.producer.run_id = 'self-authored-run'
    const changedBytes = Buffer.from(JSON.stringify(changed))
    await writeFile(copy.manifest, changedBytes)
    const changedDigest = createHash('sha256').update(changedBytes).digest('hex')
    const oldDirectory = join(copy.target, 'sha256', digest)
    const newDirectory = join(copy.target, 'sha256', changedDigest)
    await rename(oldDirectory, newDirectory)
    await expect(
      run('node', [
        'config/scripts/verify-harness-maestro-compatibility-manifest.mjs',
        '--manifest',
        join(newDirectory, 'manifest.json')
      ])
    ).rejects.toBeTruthy()
  })
})
