import { describe, expect, it } from 'vitest'
import type { InvalidArgumentError } from '../core'
import { runPackageOperation } from './mobile-web-package'

describe('mobile web package RPC errors', () => {
  it('preserves allowlisted package errors for downloader recovery', async () => {
    await expect(
      runPackageOperation(async () => {
        throw new Error('mobile_web_package_build_changed')
      })
    ).rejects.toMatchObject({
      name: 'InvalidArgumentError',
      message: 'mobile_web_package_build_changed'
    } satisfies Partial<InvalidArgumentError>)
  })

  it('maps unexpected host errors to an opaque stable error', async () => {
    await expect(
      runPackageOperation(async () => {
        throw new Error('/private/path/mobile-web: permission denied')
      })
    ).rejects.toMatchObject({
      name: 'InvalidArgumentError',
      message: 'mobile_web_package_unavailable'
    } satisfies Partial<InvalidArgumentError>)
  })
})
