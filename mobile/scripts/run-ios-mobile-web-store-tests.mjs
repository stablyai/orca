import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') {
  process.stdout.write('iOS mobile web store tests require macOS; skipped.\n')
  process.exit(0)
}

const mobileRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const temporary = await mkdtemp(join(tmpdir(), 'orca-mobile-web-store-tests-'))
const executable = join(temporary, 'mobile-web-store-tests')

try {
  await run('xcrun', [
    'swiftc',
    '-DMOBILE_WEB_PACKAGE_STORE_TESTING',
    join(mobileRoot, 'packages/expo-mobile-web-shell/ios/MobileWebCacheStoragePolicy.swift'),
    join(mobileRoot, 'packages/expo-mobile-web-shell/ios/MobileWebExactJson.swift'),
    join(mobileRoot, 'packages/expo-mobile-web-shell/ios/MobileWebActivationMetadata.swift'),
    join(mobileRoot, 'packages/expo-mobile-web-shell/ios/MobileWebCacheFileBoundary.swift'),
    join(mobileRoot, 'packages/expo-mobile-web-shell/ios/MobileWebCacheTreeBoundary.swift'),
    join(mobileRoot, 'packages/expo-mobile-web-shell/ios/MobileWebPackageStore.swift'),
    join(mobileRoot, 'packages/expo-mobile-web-shell/ios-tests/MobileWebExactJsonTests.swift'),
    join(
      mobileRoot,
      'packages/expo-mobile-web-shell/ios-tests/MobileWebActivationMetadataTests.swift'
    ),
    join(
      mobileRoot,
      'packages/expo-mobile-web-shell/ios-tests/MobileWebCacheFileBoundaryTests.swift'
    ),
    join(
      mobileRoot,
      'packages/expo-mobile-web-shell/ios-tests/MobileWebCacheCleanupBoundaryTests.swift'
    ),
    join(
      mobileRoot,
      'packages/expo-mobile-web-shell/ios-tests/MobileWebCacheWriteBoundaryTests.swift'
    ),
    join(
      mobileRoot,
      'packages/expo-mobile-web-shell/ios-tests/MobileWebHostRootBoundaryTests.swift'
    ),
    join(
      mobileRoot,
      'packages/expo-mobile-web-shell/ios-tests/MobileWebPackageStoreGeneratedMutationTests.swift'
    ),
    join(
      mobileRoot,
      'packages/expo-mobile-web-shell/ios-tests/MobileWebPackageStoreConcurrencyTests.swift'
    ),
    join(
      mobileRoot,
      'packages/expo-mobile-web-shell/ios-tests/MobileWebPackageStoreProcessInterruptionTests.swift'
    ),
    join(mobileRoot, 'packages/expo-mobile-web-shell/ios-tests/MobileWebPackageStoreTests.swift'),
    '-o',
    executable
  ])
  await run(executable, [])
  process.stdout.write('iOS mobile web store fault tests passed.\n')
} finally {
  await rm(temporary, { recursive: true, force: true })
}

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: 'inherit' })
    child.once('error', rejectRun)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolveRun()
        return
      }
      rejectRun(new Error(`${command} failed (${signal ?? code ?? 'unknown'})`))
    })
  })
}
