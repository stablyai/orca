import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { isDocsOnlyPath } from './pr-code-change-scope.mjs'

const NON_TEST_FILES = new Set([
  'mobile/Gemfile',
  'mobile/Gemfile.lock',
  'mobile/README.md',
  '.github/workflows/mobile-ios-release.yml',
  'config/scripts/pr-code-change-scope.mjs',
  'config/scripts/pr-package-test-paths.mjs',
  'config/scripts/pr-code-change-scope.test.mjs',
  'config/scripts/pr-layout-oracle-route.mjs',
  'config/scripts/mobile-release-check-scope.mjs',
  'config/scripts/mobile-release-check-scope.test.mjs'
])

const DESKTOP_SUITE_PREFIXES = [
  'src/shared/',
  'src/packages/process-host/',
  'src/main/agent-launch/',
  'src/main/runtime/rpc/',
  'src/main/runtime/runtime-rpc/',
  'src/main/runtime/agent-session-',
  'src/main/native-chat/agent-session-wire/'
]

function isDesktopSuite(file) {
  return (
    DESKTOP_SUITE_PREFIXES.some((prefix) => file.startsWith(prefix)) &&
    /\.test\.(?:[cm]?[jt]s|[jt]sx)$/.test(file)
  )
}

export function shouldRunMobileTests(files) {
  return (
    files.length === 0 ||
    files.some(
      (file) =>
        file.split('/').includes('..') ||
        (!isDocsOnlyPath(file) &&
          !NON_TEST_FILES.has(file) &&
          !isDesktopSuite(file) &&
          !file.startsWith('mobile/docs/') &&
          !file.startsWith('mobile/fastlane/'))
    )
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = readFileSync(process.argv[2], 'utf8')
  const files = input.endsWith('\0') ? input.slice(0, -1).split('\0') : []
  appendFileSync(process.env.GITHUB_OUTPUT, `should_run=${shouldRunMobileTests(files)}\n`)
}
