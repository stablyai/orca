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
    ...[
      'ios/MobileWebCacheFileBoundary.swift',
      'ios/MobileWebCacheTreeBoundary.swift',
      'ios/MobileWebPackageStore.swift',
      'ios-tests/MobileWebPackageStoreFixture.swift',
      'ios-tests/MobileWebCacheFileBoundaryTests.swift',
      'ios-tests/MobileWebCacheCleanupBoundaryTests.swift',
      'ios-tests/MobileWebCacheWriteBoundaryTests.swift',
      'ios-tests/MobileWebHostRootBoundaryTests.swift',
      'ios-tests/MobileWebPackageStoreGeneratedMutationTests.swift',
      'ios-tests/MobileWebPackageStoreConcurrencyTests.swift',
      'ios-tests/MobileWebPackageStoreProcessInterruptionTests.swift',
      'ios-tests/MobileWebPackageStoreTests.swift'
    ].map((file) => join(mobileRoot, 'packages/expo-mobile-web-shell', file)),
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
