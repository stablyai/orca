import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import {
  DAEMON_INIT_TEST_SUPPORT,
  isDaemonInitTestSupportChange,
  isUnitTestSupportSource
} from './pr-code-change-scope.mjs'

const isProductSource = (file) => !/\.test\.tsx?$/.test(file) && !isUnitTestSupportSource(file)

export const PR_E2E_SOURCE_ROUTES = [
  {
    id: 'terminal.windows-wsl-launch-and-paste',
    specs: ['tests/e2e/golden-journeys/golden-tab-bar-agent-launch.spec.ts'],
    // Covers the IPC, daemon PTY, preload and renderer owners the WSL launch crosses.
    matches: (file) =>
      isProductSource(file) &&
      /(?:^(?:config\/scripts\/runtime-verification\/participation\/(?:verify-wsl-e2e-participation|verify-playwright-participation)\.mjs$|src\/main\/(?:wsl[/-]|ipc\/wsl\/|pty\/.*wsl|(?:daemon\/)?providers\/wsl)|src\/shared\/(?:wsl-|shell\/wsl\/|remote-runtime\/(?:wsl-hosts\/|host-(?:catalog|store)\/.*wsl)|shell\/launch\/(?:windows-terminal-shell|shell-argument-quoting))|src\/preload\/api\/wsl\/|src\/renderer\/src\/(?:runtime\/hosts\/wsl\/|components\/terminal-pane\/.*wsl|.*(?:terminal-paste|pty-paste))|\.github\/(?:actions\/setup-wsl-test-runtime\/|workflows\/windows-wsl-e2e\.yml))|^(?:tests\/e2e\/golden-journeys\/golden-stub-agent\.ts|tests\/e2e\/golden-journeys\/golden-tab-bar-agent-launch\.spec\.ts|tests\/e2e\/remote\/wsl-hosts\/wsl-golden-stub-agent\.ts)$)/.test(
        file
      )
  }
]

export function selectPrE2eSpecs(
  changedPaths,
  reportRoute = () => undefined,
  { allowDaemonInitTestSupport = false } = {}
) {
  const routePaths = isDaemonInitTestSupportChange(changedPaths, allowDaemonInitTestSupport)
    ? changedPaths.filter((file) => file !== DAEMON_INIT_TEST_SUPPORT)
    : changedPaths
  // A changed spec always runs itself.
  const specs = new Set(changedPaths.filter((file) => /^tests\/e2e\/.+\.spec\.ts$/.test(file)))
  for (const route of PR_E2E_SOURCE_ROUTES) {
    const matchedFiles = routePaths.filter(route.matches)
    if (matchedFiles.length === 0) {
      continue
    }
    route.specs.forEach((spec) => specs.add(spec))
    reportRoute(`[pr-e2e] ${route.id}: ${route.specs.join(', ')}`)
  }
  return [...specs].sort((left, right) => left.localeCompare(right))
}

export function shouldRunReusablePrE2e(changedPaths, options = {}) {
  return selectPrE2eSpecs(changedPaths, undefined, options).length > 0
}

export function hasWslSourceChange(changedPaths) {
  const route = PR_E2E_SOURCE_ROUTES.find(
    (candidate) => candidate.id === 'terminal.windows-wsl-launch-and-paste'
  )
  return changedPaths.some(route.matches)
}

/** A route naming a deleted spec fails every later PR that touches its sources, so refuse it here. */
function missingRouteSpecs() {
  const specs = [...new Set(PR_E2E_SOURCE_ROUTES.flatMap((route) => route.specs))]
  // CI's sparse checkout omits tests/e2e/, so ask the index rather than the disk.
  const tracked = new Set(
    execFileSync('git', ['ls-files', '-z', '--', ...specs], {
      cwd: resolve(import.meta.dirname, '../../../..'),
      encoding: 'utf8'
    }).split('\0')
  )
  return PR_E2E_SOURCE_ROUTES.flatMap((route) =>
    route.specs.filter((spec) => !tracked.has(spec)).map((spec) => `${route.id}: ${spec}`)
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const missing = missingRouteSpecs()
  if (missing.length > 0) {
    console.error(
      `E2E source routes name specs that are not tracked; remove each from its route along with the spec:\n${missing.join('\n')}`
    )
    process.exit(1)
  }
  let input = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) {
    input += chunk
  }
  const changedPaths = input.split(/\r?\n/).filter(Boolean)
  const options = {
    allowDaemonInitTestSupport: process.argv.includes('--daemon-init-test-support')
  }
  if (process.argv.includes('--reusable-workflow')) {
    process.stdout.write(`${shouldRunReusablePrE2e(changedPaths, options)}\n`)
  } else if (process.argv.includes('--wsl-source')) {
    process.stdout.write(`${hasWslSourceChange(changedPaths)}\n`)
  } else {
    const specs = selectPrE2eSpecs(changedPaths, (message) => console.error(message), options)
    process.stdout.write(`${JSON.stringify(specs)}\n`)
  }
}
