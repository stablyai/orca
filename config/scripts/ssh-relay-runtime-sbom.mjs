import { createRequire } from 'node:module'

import { sshRelayRuntimeWatcherPackage } from './ssh-relay-runtime-closure.mjs'

const require = createRequire(import.meta.url)

function spdxId(value) {
  return `SPDXRef-${value.replace(/[^A-Za-z0-9.-]/g, '-')}`
}

function packageRecord(name, version, license) {
  return {
    name,
    SPDXID: spdxId(`Package-${name}`),
    versionInfo: version,
    downloadLocation: 'NOASSERTION',
    filesAnalyzed: false,
    licenseConcluded: license,
    licenseDeclared: license,
    copyrightText: 'NOASSERTION'
  }
}

function installedPackage(name) {
  const parsed = require(`${name}/package.json`)
  return packageRecord(parsed.name, parsed.version, parsed.license ?? 'NOASSERTION')
}

function fileType(role) {
  return ['node', 'node-pty-native', 'parcel-watcher-native', 'native-runtime'].includes(role)
    ? 'BINARY'
    : role === 'license'
      ? 'TEXT'
      : 'SOURCE'
}

function ownerPackage(path, packages) {
  const packagePath = packages.find((entry) => path.startsWith(`node_modules/${entry.name}/`))
  if (packagePath) {
    return packagePath
  }
  if (path.startsWith('node_modules/')) {
    return undefined
  }
  if (path === 'bin/node' || path === 'bin/node.exe') {
    return packages.find((entry) => entry.name === 'node')
  }
  return packages.find((entry) => entry.name === 'orca-ssh-relay')
}

export function createSshRelayRuntimeSbom({ identity, archive, sourceDateEpoch }) {
  if (!/^sha256:[0-9a-f]{64}$/.test(archive?.sha256 ?? '')) {
    throw new Error('Runtime SBOM requires the exact archive SHA-256')
  }
  const watcherPackage = sshRelayRuntimeWatcherPackage(identity.tupleId)
  const packages = [
    packageRecord('node', identity.nodeVersion, 'MIT'),
    packageRecord('orca-ssh-relay', identity.contentId, 'NOASSERTION'),
    installedPackage('node-pty'),
    installedPackage('@parcel/watcher'),
    installedPackage(watcherPackage),
    installedPackage('detect-libc'),
    installedPackage('is-glob'),
    installedPackage('is-extglob'),
    installedPackage('picomatch')
  ]
  const files = identity.entries
    .filter((entry) => entry.type === 'file')
    .map((entry) => ({
      fileName: entry.path,
      SPDXID: spdxId(`File-${entry.path}`),
      fileTypes: [fileType(entry.role)],
      checksums: [{ algorithm: 'SHA256', checksumValue: entry.sha256.slice('sha256:'.length) }],
      licenseConcluded: 'NOASSERTION',
      copyrightText: 'NOASSERTION'
    }))
  const identifiers = new Set()
  for (const element of [...packages, ...files]) {
    if (identifiers.has(element.SPDXID)) {
      throw new Error(`Runtime SBOM contains a duplicate SPDX identifier: ${element.SPDXID}`)
    }
    identifiers.add(element.SPDXID)
  }
  const contains = files.map((file) => {
    const owner = ownerPackage(file.fileName, packages)
    if (!owner) {
      throw new Error(`Runtime SBOM cannot assign a package owner: ${file.fileName}`)
    }
    return {
      spdxElementId: owner.SPDXID,
      relationshipType: 'CONTAINS',
      relatedSpdxElement: file.SPDXID
    }
  })
  const relay = packages.find((entry) => entry.name === 'orca-ssh-relay')
  const relationships = [
    ...packages.map((component) => ({
      spdxElementId: 'SPDXRef-DOCUMENT',
      relationshipType: 'DESCRIBES',
      relatedSpdxElement: component.SPDXID
    })),
    ...packages
      .filter((component) => component !== relay)
      .map((component) => ({
        spdxElementId: relay.SPDXID,
        relationshipType: 'DEPENDS_ON',
        relatedSpdxElement: component.SPDXID
      })),
    ...contains
  ]
  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `Orca SSH relay runtime ${identity.tupleId}`,
    documentNamespace: `https://github.com/stablyai/orca/ssh-relay-runtime/spdx/${archive.sha256.slice('sha256:'.length)}`,
    creationInfo: {
      created: new Date(sourceDateEpoch * 1000).toISOString(),
      creators: ['Organization: Stably AI']
    },
    packages,
    files,
    relationships
  }
}
