import { X509Certificate } from 'node:crypto'
import { rootCertificates } from 'node:tls'
import { describe, expect, it } from 'vitest'
import type { ProcessResult } from '../../shared/child-process/run-process'
import {
  applyLegacySystemCaPolicy,
  loadLegacySystemCaCertificates,
  loadLegacySystemCaPolicy
} from './first-party-ca-certificates'

const bundledRoot = rootCertificates.find((pem) => {
  const certificate = new X509Certificate(pem)
  return certificate.ca && certificate.checkIssued(certificate)
})
const bundledRoots = rootCertificates
  .filter((pem) => {
    const certificate = new X509Certificate(pem)
    return certificate.ca && certificate.checkIssued(certificate)
  })
  .slice(0, 9)

if (!bundledRoot || bundledRoots.length < 9) {
  throw new Error('expected current bundled root certificates')
}

function processResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    code: 0,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    ...overrides
  }
}

describe('legacy system CA loading', () => {
  it('reads the policy-owned Linux bundle when Node cannot enumerate system roots', async () => {
    const certificates = await loadLegacySystemCaCertificates({
      platform: 'linux',
      env: { SSL_CERT_FILE: '/fixture/ca-bundle.crt' },
      readFile: async (path) => {
        expect(path).toBe('/fixture/ca-bundle.crt')
        return bundledRoot
      }
    })

    expect(certificates).toEqual([bundledRoot])
  })

  it('bounds a stalled Linux certificate bundle read', async () => {
    const certificates = await loadLegacySystemCaCertificates({
      platform: 'linux',
      trustLoadTimeoutMs: 5,
      readFile: () => new Promise<string>(() => {})
    })

    expect(certificates).toEqual([])
  })

  it('accepts only macOS roots that the host trust policy verifies', async () => {
    const signals: (AbortSignal | undefined)[] = []
    const accepted = await loadLegacySystemCaCertificates({
      platform: 'darwin',
      runProcess: async (spec) => {
        signals.push(spec.signal)
        return spec.args?.[0] === 'find-certificate'
          ? processResult({ stdout: bundledRoot })
          : processResult()
      }
    })
    const rejected = await loadLegacySystemCaCertificates({
      platform: 'darwin',
      runProcess: async (spec) =>
        spec.args?.[0] === 'find-certificate'
          ? processResult({ stdout: bundledRoot })
          : processResult({ code: 1 })
    })

    expect(accepted).toEqual([bundledRoot])
    expect(rejected).toEqual([])
    expect(signals).toHaveLength(2)
    expect(signals[0]).toBeDefined()
    expect(signals[1]).toBe(signals[0])
  })

  it('bounds concurrent macOS trust verification', async () => {
    let active = 0
    let maxActive = 0
    let verificationCount = 0
    const certificates = await loadLegacySystemCaCertificates({
      platform: 'darwin',
      runProcess: async (spec) => {
        if (spec.args?.[0] === 'find-certificate') {
          return processResult({ stdout: bundledRoots.join('\n') })
        }
        verificationCount += 1
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise<void>((resolve) => setImmediate(resolve))
        active -= 1
        return processResult()
      }
    })

    expect(certificates).toHaveLength(9)
    expect(verificationCount).toBe(9)
    expect(maxActive).toBe(8)
  })

  it('bounds stalled macOS listing and verification with one aggregate deadline', async () => {
    const stalledListing = loadLegacySystemCaCertificates({
      platform: 'darwin',
      trustLoadTimeoutMs: 5,
      runProcess: () => new Promise<ProcessResult>(() => {})
    })
    const stalledVerification = loadLegacySystemCaCertificates({
      platform: 'darwin',
      trustLoadTimeoutMs: 5,
      runProcess: async (spec) =>
        spec.args?.[0] === 'find-certificate'
          ? processResult({ stdout: bundledRoot })
          : await new Promise<ProcessResult>(() => {})
    })

    await expect(stalledListing).resolves.toEqual([])
    await expect(stalledVerification).resolves.toEqual([])
  })

  it('reads both Windows root locations and subtracts their disallowed stores', async () => {
    const calls: { store: string; storeTypeList: string[] }[] = []
    const load = (disallowed: string[]) =>
      loadLegacySystemCaCertificates({
        platform: 'win32',
        loadWindowsCaModule: async () => ({
          exportSystemCertificatesAsync: async (options) => {
            calls.push(options)
            return options.store === 'Disallowed' ? disallowed : [bundledRoot]
          }
        })
      })

    expect(await load([])).toHaveLength(1)
    expect(await load([bundledRoot])).toEqual([])
    expect(calls).toEqual(
      expect.arrayContaining(
        ['ROOT', 'Disallowed'].flatMap((store) =>
          ['CERT_SYSTEM_STORE_LOCAL_MACHINE', 'CERT_SYSTEM_STORE_CURRENT_USER'].map(
            (storeType) => ({ store, storeTypeList: [storeType] })
          )
        )
      )
    )
  })

  it('retains a readable Windows store and applies Disallowed to the merged trust set', async () => {
    const policy = await loadLegacySystemCaPolicy({
      platform: 'win32',
      loadWindowsCaModule: async () => ({
        exportSystemCertificatesAsync: async ({ store, storeTypeList }) => {
          if (storeTypeList[0] === 'CERT_SYSTEM_STORE_CURRENT_USER') {
            throw new Error('store unavailable')
          }
          return store === 'Disallowed' ? [bundledRoots[1]] : [bundledRoot]
        }
      })
    })

    expect(policy.certificates).toEqual([bundledRoot])
    expect(applyLegacySystemCaPolicy([bundledRoots[1]], policy)).toEqual([])
  })

  it('bounds a stalled Windows certificate store', async () => {
    const certificates = await loadLegacySystemCaCertificates({
      platform: 'win32',
      trustLoadTimeoutMs: 5,
      loadWindowsCaModule: async () => ({
        exportSystemCertificatesAsync: () => new Promise<string[]>(() => {})
      })
    })

    expect(certificates).toEqual([])
  })
})
