import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { DEFAULT_EXPECTED_SIGNER } from './verify-windows-inner-signature.mjs'
import { verifyPackagedWindowsRuntimePipeBrokerSignature } from './verify-packaged-windows-runtime-pipe-broker-signature.mjs'

function fixture() {
  const resources = mkdtempSync(join(tmpdir(), 'orca-signed-broker-package-'))
  mkdirSync(join(resources, 'bin'))
  writeFileSync(join(resources, 'bin', 'orca-pipe-broker.exe'), 'fixture')
  return resources
}

describe('final packaged broker signature gate', () => {
  it('rejects a payload without the broker before checking a signature', () => {
    const resources = mkdtempSync(join(tmpdir(), 'orca-missing-broker-package-'))
    assert.throws(
      () =>
        verifyPackagedWindowsRuntimePipeBrokerSignature(resources, {
          verifySignature: () => assert.fail('signature checker must not run')
        }),
      /Missing broker from final package payload/
    )
  })

  it('rejects an invalid signature', () => {
    assert.throws(
      () =>
        verifyPackagedWindowsRuntimePipeBrokerSignature(fixture(), {
          verifySignature: () => {
            throw new Error('signature status is NotSigned')
          }
        }),
      /NotSigned/
    )
  })

  it('requires the exact authorized signer identity', () => {
    const resources = fixture()
    let received
    verifyPackagedWindowsRuntimePipeBrokerSignature(resources, {
      verifySignature: (options) => {
        received = options
        return { status: 'Valid', signerSubject: DEFAULT_EXPECTED_SIGNER }
      }
    })
    assert.deepEqual(received.expectedSigners, [DEFAULT_EXPECTED_SIGNER])
    assert.deepEqual(received.expectedThumbprints, [])
  })
})
