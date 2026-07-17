import { createHash } from 'node:crypto'
import { chmod, cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { verifySshRelayRuntimeReproducibility } from './ssh-relay-runtime-reproducibility.mjs'

const temporaryDirectories = []
const tuple = 'linux-x64-glibc'
const contentId = `sha256:${'a'.repeat(64)}`
const archiveBytes = 'archive bytes'
const archiveSha256 = `sha256:${createHash('sha256').update(archiveBytes).digest('hex')}`
const archiveName = `orca-ssh-relay-runtime-v1-${tuple}-${contentId.slice('sha256:'.length)}.tar.br`

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

async function writeOutput(directory) {
  await mkdir(join(directory, 'runtime'), { recursive: true })
  await Promise.all([
    writeFile(join(directory, 'runtime', 'relay.js'), 'relay bytes'),
    writeFile(join(directory, 'runtime', 'relay-watcher.js'), 'watcher bytes'),
    writeFile(join(directory, 'runtime', 'runtime-metadata.json'), '{"schemaVersion":1}\n'),
    writeFile(join(directory, archiveName), archiveBytes),
    writeFile(
      join(directory, `orca-ssh-relay-runtime-${tuple}.identity.json`),
      `${JSON.stringify({ tupleId: tuple, contentId, archive: { name: archiveName, sha256: archiveSha256 } })}\n`
    ),
    writeFile(
      join(directory, `orca-ssh-relay-runtime-${tuple}.spdx.json`),
      '{"spdxVersion":"SPDX-2.3"}\n'
    ),
    writeFile(
      join(directory, `orca-ssh-relay-runtime-${tuple}.provenance.json`),
      '{"predicateType":"https://slsa.dev/provenance/v1"}\n'
    )
  ])
}

async function createOutputs() {
  const directory = await mkdtemp(join(tmpdir(), 'orca-runtime-reproducibility-'))
  temporaryDirectories.push(directory)
  const firstOutputDirectory = join(directory, 'first')
  const secondOutputDirectory = join(directory, 'second')
  await writeOutput(firstOutputDirectory)
  await cp(firstOutputDirectory, secondOutputDirectory, { recursive: true })
  return { directory, firstOutputDirectory, secondOutputDirectory }
}

describe('SSH relay runtime clean-build reproducibility', () => {
  it('accepts byte-and-mode-identical complete outputs', async () => {
    const fixture = await createOutputs()

    await expect(
      verifySshRelayRuntimeReproducibility({
        ...fixture,
        tuple
      })
    ).resolves.toEqual(expect.objectContaining({ tuple, contentId, archiveSha256, files: 7 }))
  })

  it('rejects runtime-tree byte drift', async () => {
    const fixture = await createOutputs()
    await writeFile(join(fixture.secondOutputDirectory, 'runtime', 'relay.js'), 'other bytes')

    await expect(verifySshRelayRuntimeReproducibility({ ...fixture, tuple })).rejects.toThrow(
      'reproducibility mismatch for runtime/relay.js: sha256'
    )
  })

  it('reports runtime drift before derived identity drift', async () => {
    const fixture = await createOutputs()
    await writeFile(join(fixture.secondOutputDirectory, 'runtime', 'relay.js'), 'other bytes')
    const identityPath = join(
      fixture.secondOutputDirectory,
      `orca-ssh-relay-runtime-${tuple}.identity.json`
    )
    await writeFile(
      identityPath,
      `${JSON.stringify({ tupleId: tuple, contentId: `sha256:${'c'.repeat(64)}`, archive: { name: archiveName, sha256: archiveSha256 } })}\n`
    )

    await expect(verifySshRelayRuntimeReproducibility({ ...fixture, tuple })).rejects.toThrow(
      'reproducibility mismatch for runtime/relay.js: sha256'
    )
  })

  it('rejects SBOM byte drift', async () => {
    const fixture = await createOutputs()
    await writeFile(
      join(fixture.secondOutputDirectory, `orca-ssh-relay-runtime-${tuple}.spdx.json`),
      '{"spdxVersion":"SPDX-2.2"}\n'
    )

    await expect(verifySshRelayRuntimeReproducibility({ ...fixture, tuple })).rejects.toThrow(
      `reproducibility mismatch for orca-ssh-relay-runtime-${tuple}.spdx.json: sha256`
    )
  })

  it('rejects an archive that disagrees with its identity', async () => {
    const fixture = await createOutputs()
    await writeFile(join(fixture.secondOutputDirectory, archiveName), 'other archive bytes')

    await expect(verifySshRelayRuntimeReproducibility({ ...fixture, tuple })).rejects.toThrow(
      'second output archive digest does not match its identity'
    )
  })

  it('rejects a missing published metadata asset', async () => {
    const fixture = await createOutputs()
    await rm(join(fixture.secondOutputDirectory, `orca-ssh-relay-runtime-${tuple}.spdx.json`))

    await expect(verifySshRelayRuntimeReproducibility({ ...fixture, tuple })).rejects.toThrow(
      `second output is missing required asset: orca-ssh-relay-runtime-${tuple}.spdx.json`
    )
  })

  it.skipIf(process.platform === 'win32')('rejects mode drift', async () => {
    const fixture = await createOutputs()
    await chmod(join(fixture.secondOutputDirectory, 'runtime', 'relay.js'), 0o755)

    await expect(verifySshRelayRuntimeReproducibility({ ...fixture, tuple })).rejects.toThrow(
      'reproducibility mismatch for runtime/relay.js: mode'
    )
  })

  it.skipIf(process.platform === 'win32')(
    'rejects links before reading their targets',
    async () => {
      const fixture = await createOutputs()
      await symlink(
        join(fixture.directory, 'outside'),
        join(fixture.firstOutputDirectory, 'runtime', 'escape')
      )

      await expect(verifySshRelayRuntimeReproducibility({ ...fixture, tuple })).rejects.toThrow(
        'first output contains a prohibited special entry: runtime/escape'
      )
    }
  )

  it('rejects the same directory and a pre-aborted comparison', async () => {
    const fixture = await createOutputs()
    await expect(
      verifySshRelayRuntimeReproducibility({
        firstOutputDirectory: fixture.firstOutputDirectory,
        secondOutputDirectory: fixture.firstOutputDirectory,
        tuple
      })
    ).rejects.toThrow('clean-build outputs must be distinct directories')
    await expect(
      verifySshRelayRuntimeReproducibility({
        ...fixture,
        tuple,
        signal: AbortSignal.abort()
      })
    ).rejects.toThrow('aborted')
  })
})
