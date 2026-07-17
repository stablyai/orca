import { describe, expect, it } from 'vitest'

import { createSshRelayRuntimeSbom } from './ssh-relay-runtime-sbom.mjs'

const sha256 = (character) => `sha256:${character.repeat(64)}`

function file(path, role, character) {
  return { path, type: 'file', role, size: 1, mode: 0o644, sha256: sha256(character) }
}

function identity(tuple = 'linux-arm64-glibc') {
  return {
    tupleId: tuple,
    nodeVersion: '24.18.0',
    contentId: sha256('f'),
    entries: [
      file('bin/node', 'node', '1'),
      file('relay.js', 'relay', '2'),
      file('THIRD_PARTY_LICENSES.txt', 'license', '3'),
      file('node_modules/node-pty/lib/index.js', 'runtime-javascript', '4'),
      file('node_modules/@parcel/watcher/index.js', 'runtime-javascript', '5'),
      file(`node_modules/@parcel/watcher-${tuple}/watcher.node`, 'parcel-watcher-native', '6'),
      file('node_modules/detect-libc/lib/detect-libc.js', 'runtime-javascript', '7'),
      file('node_modules/is-glob/index.js', 'runtime-javascript', '8'),
      file('node_modules/is-extglob/index.js', 'runtime-javascript', '9'),
      file('node_modules/picomatch/index.js', 'runtime-javascript', 'a')
    ]
  }
}

const archive = { sha256: sha256('e') }

function ownerName(sbom, fileName) {
  const fileId = sbom.files.find((entry) => entry.fileName === fileName).SPDXID
  const owners = sbom.relationships.filter(
    (entry) => entry.relationshipType === 'CONTAINS' && entry.relatedSpdxElement === fileId
  )
  expect(owners).toHaveLength(1)
  return sbom.packages.find((entry) => entry.SPDXID === owners[0].spdxElementId).name
}

describe('SSH relay runtime SPDX SBOM', () => {
  it('inventories every runtime file under exactly one package', () => {
    const fixture = identity()
    const sbom = createSshRelayRuntimeSbom({
      identity: fixture,
      archive,
      sourceDateEpoch: 1_752_710_400
    })

    expect(sbom.spdxVersion).toBe('SPDX-2.3')
    expect(sbom.documentNamespace).toBe(
      `https://github.com/stablyai/orca/ssh-relay-runtime/spdx/${'e'.repeat(64)}`
    )
    expect(sbom.creationInfo.created).toBe('2025-07-17T00:00:00.000Z')
    expect(sbom.packages.map((entry) => entry.name)).toEqual([
      'node',
      'orca-ssh-relay',
      'node-pty',
      '@parcel/watcher',
      '@parcel/watcher-linux-arm64-glibc',
      'detect-libc',
      'is-glob',
      'is-extglob',
      'picomatch'
    ])
    expect(sbom.packages.find((entry) => entry.name === 'node')).toMatchObject({
      versionInfo: '24.18.0',
      licenseDeclared: 'MIT'
    })
    expect(sbom.packages.find((entry) => entry.name === 'orca-ssh-relay')).toMatchObject({
      versionInfo: fixture.contentId,
      licenseDeclared: 'NOASSERTION'
    })
    expect(sbom.files).toHaveLength(fixture.entries.length)
    expect(new Set([...sbom.packages, ...sbom.files].map((entry) => entry.SPDXID)).size).toBe(
      sbom.packages.length + sbom.files.length
    )
    expect(ownerName(sbom, 'bin/node')).toBe('node')
    expect(ownerName(sbom, 'relay.js')).toBe('orca-ssh-relay')
    expect(ownerName(sbom, 'THIRD_PARTY_LICENSES.txt')).toBe('orca-ssh-relay')
    expect(ownerName(sbom, 'node_modules/node-pty/lib/index.js')).toBe('node-pty')
    expect(ownerName(sbom, 'node_modules/@parcel/watcher/index.js')).toBe('@parcel/watcher')
    expect(ownerName(sbom, 'node_modules/@parcel/watcher-linux-arm64-glibc/watcher.node')).toBe(
      '@parcel/watcher-linux-arm64-glibc'
    )
    expect(ownerName(sbom, 'node_modules/detect-libc/lib/detect-libc.js')).toBe('detect-libc')
    expect(ownerName(sbom, 'node_modules/is-glob/index.js')).toBe('is-glob')
    expect(ownerName(sbom, 'node_modules/is-extglob/index.js')).toBe('is-extglob')
    expect(ownerName(sbom, 'node_modules/picomatch/index.js')).toBe('picomatch')
    expect(
      sbom.relationships.filter((entry) => entry.relationshipType === 'DEPENDS_ON')
    ).toHaveLength(8)
  })

  it('rejects an unowned node_modules path and colliding SPDX identifiers', () => {
    const unowned = identity()
    unowned.entries.push(file('node_modules/unreviewed/index.js', 'runtime-javascript', 'b'))
    expect(() =>
      createSshRelayRuntimeSbom({ identity: unowned, archive, sourceDateEpoch: 1_752_710_400 })
    ).toThrow(/cannot assign a package owner/i)

    const collision = identity()
    collision.entries.push(
      file('relay/a+b.js', 'runtime-javascript', 'b'),
      file('relay/a@b.js', 'runtime-javascript', 'c')
    )
    expect(() =>
      createSshRelayRuntimeSbom({ identity: collision, archive, sourceDateEpoch: 1_752_710_400 })
    ).toThrow(/duplicate SPDX identifier/i)
  })

  it('requires the exact archive digest to make the document namespace immutable', () => {
    expect(() =>
      createSshRelayRuntimeSbom({
        identity: identity(),
        archive: { sha256: 'missing-prefix' },
        sourceDateEpoch: 1_752_710_400
      })
    ).toThrow(/archive SHA-256/i)
  })
})
