import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  SkillBundleInstallRequest,
  SkillBundleInstallResult
} from '../../shared/skill-bundle-install-contract'
import type { SkillInstallRequest, SkillInstallResult } from '../../shared/skill-install-contract'
import { SKILL_PACKAGE_CONTENT_TYPE } from '../../shared/skill-package-manifest'
import { collectBundle } from '../observability/bundle'
import { _resetTracerForTests, setActiveSink, type TracerSink } from '../observability/tracer'
import {
  recordSkillCapabilityAbsence,
  startSkillBundleInstallOperation,
  startSkillInstallOperation,
  startSkillPhaseOperation
} from './skill-operation-observability'
import { createSkillPackageArchive } from './skill-package-creation'
import { downloadSkillPackageGrant } from './skill-package-download'
import { reconcileSkillProviderPlacement } from './skill-placement-reconciliation'
import { settleObservedSkillTransactionRecovery } from './skill-transaction-recovery-observability'

type CapturingSink = TracerSink & { records: unknown[] }

const PRIVATE_VALUES = {
  localPath: '/Users/private/team skills/payroll-skill.tar.gz',
  canonicalPath: '/Users/private/.agents/skills/payroll',
  providerPath: '/Users/private/.codex/skills/payroll',
  connectionId: 'private-production-ssh',
  skillName: 'payroll-instructions',
  filename: 'salary-review.md',
  manifest: 'manifest={private-instructions}',
  acl: 'acl=private-user-id',
  shareUrl: 'orca://skill-share/private-share-id',
  uploadPolicy: 'policy=private-signed-upload',
  downloadGrant: 'https://storage.googleapis.com/private-bucket/object?X-Goog-Signature=secret',
  credential: 'authorization=Bearer private-access-token'
}

function request(): SkillInstallRequest {
  return {
    operationId: 'operation-private',
    package: {
      packageId: 'package-123',
      versionId: 'version-456',
      packageDigest: 'a'.repeat(64),
      archiveSha256: 'b'.repeat(64),
      compressedBytes: 1234
    },
    ingress: { kind: 'local-file', path: PRIVATE_VALUES.localPath },
    destination: {
      scope: 'global',
      executionTarget: { kind: 'ssh', connectionId: PRIVATE_VALUES.connectionId }
    }
  }
}

function result(): SkillInstallResult {
  return {
    operationId: 'operation-private',
    status: 'installed',
    name: PRIVATE_VALUES.skillName,
    packageDigest: 'a'.repeat(64),
    canonicalPath: PRIVATE_VALUES.canonicalPath,
    placements: [
      {
        provider: 'codex',
        path: PRIVATE_VALUES.providerPath,
        topology: 'provider-alias',
        status: 'installed'
      }
    ]
  }
}

function bundleRequest(): SkillBundleInstallRequest {
  return {
    operationId: 'bundle-operation-private',
    package: {
      packageId: 'bundle-package-123',
      versionId: 'bundle-version-456',
      bundleDigest: 'c'.repeat(64),
      archiveSha256: 'd'.repeat(64),
      compressedBytes: 4321
    },
    selectedSkillIds: ['selected-private-skill'],
    ingress: { kind: 'local-file', path: PRIVATE_VALUES.localPath },
    destination: {
      scope: 'global',
      executionTarget: { kind: 'ssh', connectionId: PRIVATE_VALUES.connectionId }
    },
    conflictDecisions: [
      { skillId: 'selected-private-skill', resolution: 'replace-and-discard-local' }
    ]
  }
}

function bundleResult(): SkillBundleInstallResult {
  return {
    operationId: 'bundle-operation-private',
    packageId: 'bundle-package-123',
    versionId: 'bundle-version-456',
    bundleDigest: 'c'.repeat(64),
    status: 'partial',
    skills: [
      {
        skillId: 'selected-private-skill',
        name: PRIVATE_VALUES.skillName,
        digest: 'e'.repeat(64),
        status: 'kept-local',
        canonicalPath: PRIVATE_VALUES.canonicalPath,
        placements: [
          {
            provider: 'codex',
            path: PRIVATE_VALUES.providerPath,
            topology: 'provider-alias',
            status: 'skipped'
          }
        ],
        conflict: { kind: 'modified', existingDigest: 'f'.repeat(64) },
        errorCategory: PRIVATE_VALUES.manifest
      }
    ]
  }
}

let sink: CapturingSink
let directory: string

beforeEach(() => {
  sink = {
    records: [],
    push(record) {
      this.records.push(record)
    },
    flush() {},
    close() {}
  }
  directory = mkdtempSync(join(tmpdir(), 'orca-skill-observability-'))
  setActiveSink(sink)
})

afterEach(() => {
  _resetTracerForTests()
  rmSync(directory, { recursive: true, force: true })
})

describe('skill operation observability', () => {
  it('maps install results to bounded labels without private operation data', () => {
    const operation = startSkillInstallOperation(request())
    operation.complete(result())

    const serialized = JSON.stringify(sink.records)
    expect(serialized).toContain('package-123')
    expect(serialized).toContain('version-456')
    expect(serialized).toContain('global-ssh')
    expect(serialized).toContain('provider-alias')
    for (const value of Object.values(PRIVATE_VALUES)) {
      expect(serialized).not.toContain(value)
    }
  })

  it('keeps support bundles free of paths, filenames, share URLs, policies, ACLs, and grants', () => {
    const operation = startSkillInstallOperation({
      ...request(),
      ingress: {
        kind: 'download-grant',
        url: PRIVATE_VALUES.downloadGrant,
        expiresAt: '2030-01-01T00:00:00Z'
      }
    })
    operation.fail(new Error(Object.values(PRIVATE_VALUES).join(' ')))
    const traceFile = join(directory, 'trace.ndjson')
    writeFileSync(traceFile, `${sink.records.map((record) => JSON.stringify(record)).join('\n')}\n`)

    const bundle = collectBundle({
      traceFilePath: traceFile,
      maxFiles: 1,
      appVersion: 'test',
      platform: 'darwin',
      arch: 'arm64',
      osRelease: 'test',
      orcaChannel: 'dev'
    })

    expect(bundle.payload).toContain('skill-install-unknown')
    for (const value of Object.values(PRIVATE_VALUES)) {
      expect(bundle.payload).not.toContain(value)
    }
  })

  it('records bundle counts and conflicts without skill identities or paths', () => {
    const operation = startSkillBundleInstallOperation(bundleRequest())
    operation.complete(bundleResult())

    const serialized = JSON.stringify(sink.records)
    expect(serialized).toContain('bundle-package-123')
    expect(serialized).toContain('selectedSkillCount')
    expect(serialized).toContain('modified')
    expect(serialized).toContain('provider-alias')
    expect(serialized).not.toContain('selected-private-skill')
    for (const value of Object.values(PRIVATE_VALUES)) {
      expect(serialized).not.toContain(value)
    }
  })

  it('bounds phase counts and records only fixed capability labels', () => {
    const recovery = startSkillPhaseOperation({ phase: 'recovery', destination: 'startup' })
    recovery.complete({
      status: 'partial',
      scannedCount: Number.MAX_SAFE_INTEGER,
      recoveredCount: 4,
      failureCount: 1,
      orphanCount: 3,
      truncated: true
    })
    const upload = startSkillPhaseOperation({
      phase: 'upload',
      compressedBytes: 40 * 1024 * 1024
    })
    upload.complete({ status: 'complete' })
    recordSkillCapabilityAbsence({
      capability: 'skills.install.bundle.v1',
      destination: 'remote-runtime'
    })

    const serialized = JSON.stringify(sink.records)
    expect(serialized).toContain('1000000')
    expect(serialized).toContain('41943040')
    expect(serialized).toContain('orphanCount')
    expect(serialized).toContain('skills.install.bundle.v1')
    expect(serialized).toContain('remote-runtime')
  })

  it('reduces phase failures to a bounded category', () => {
    const download = startSkillPhaseOperation({
      phase: 'download',
      transport: 'download-grant',
      compressedBytes: 1234
    })
    download.fail(new Error(Object.values(PRIVATE_VALUES).join(' ')))

    const serialized = JSON.stringify(sink.records)
    expect(serialized).toContain('skill-operation-unknown')
    for (const value of Object.values(PRIVATE_VALUES)) {
      expect(serialized).not.toContain(value)
    }
  })

  it('measures real package, download, and placement phases without local paths', async () => {
    const source = join(directory, 'private-source')
    const archivePath = join(directory, 'private-package.tar.gz')
    mkdirSync(source)
    writeFileSync(
      join(source, 'SKILL.md'),
      '---\nname: observed-skill\ndescription: Private test\n---\n\nPrivate instructions\n'
    )
    const created = await createSkillPackageArchive({
      sourceDirectory: source,
      archivePath,
      packageId: 'observed-package',
      versionId: 'observed-version'
    })
    const archive = readFileSync(archivePath)
    const fetcher: typeof fetch = async () =>
      new Response(Uint8Array.from(archive), {
        headers: {
          'content-type': SKILL_PACKAGE_CONTENT_TYPE,
          'content-length': String(archive.length)
        }
      })
    const downloaded = await downloadSkillPackageGrant({
      url: 'https://storage.test/package',
      expiresAt: '2030-01-01T00:00:00Z',
      expectedArchiveSha256: created.archiveSha256,
      expectedCompressedBytes: created.compressedBytes,
      temporaryRoot: join(directory, 'private-downloads'),
      allowedOrigins: ['https://storage.test'],
      requireHttps: true,
      fetcher
    })
    await downloaded.cleanup()

    const providerRoot = join(directory, 'private-provider')
    const placement = await reconcileSkillProviderPlacement({
      canonicalPath: source,
      skillName: 'observed-skill',
      destination: { provider: 'claude', readsCanonicalRoot: false, rootPath: providerRoot },
      previousReceipt: null,
      packageDigest: created.manifest.packageDigest
    })

    expect(placement?.status).toBe('installed')
    const serialized = JSON.stringify(sink.records)
    expect(serialized).toContain('skill.package')
    expect(serialized).toContain('skill.download')
    expect(serialized).toContain('skill.placement')
    expect(serialized).toContain('fileCount')
    expect(serialized).not.toContain(source)
    expect(serialized).not.toContain(archivePath)
    expect(serialized).not.toContain(providerRoot)
    expect(serialized).not.toContain('observed-skill')
    expect(serialized).not.toContain('Private instructions')
  })

  it('records transaction rollback settlement without exposing recovery errors', async () => {
    await settleObservedSkillTransactionRecovery({
      rollback: true,
      recover: async () => undefined
    })
    await settleObservedSkillTransactionRecovery({
      rollback: false,
      recover: async () => {
        throw new Error(`${PRIVATE_VALUES.canonicalPath} recovery failed`)
      }
    })

    const serialized = JSON.stringify(sink.records)
    expect(serialized).toContain('rollbackCount')
    expect(serialized).toContain('skill-operation-unknown')
    expect(serialized).not.toContain(PRIVATE_VALUES.canonicalPath)
  })
})
