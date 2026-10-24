import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isLayoutOracleSource } from './pr-layout-oracle-route.mjs'
import {
  isWindowsProcessProbePath,
  LINUX_PACKAGE_TESTS,
  WINDOWS_PACKAGE_TESTS
} from './pr-package-test-paths.mjs'

const DOCS_ONLY_FILES = new Set([
  'README.md',
  'LICENSE',
  'AGENTS.md',
  'CLAUDE.md',
  'Agents.md',
  'Claude.md',
  '.github/CONTRIBUTING.md',
  '.github/pull_request_template.md',
  '.github/CODEOWNERS'
])

const DOCS_ONLY_PREFIXES = ['docs/', '.github/ISSUE_TEMPLATE/']

export const PR_CHECK_JOBS = [
  'static_analysis',
  'typecheck',
  'git_compatibility',
  'codex_index_heal_contract',
  'xterm_patch_sync',
  'shell_contracts',
  'test',
  'orcad_browser',
  'mobile_web_app',
  'cross-version-wire',
  'managed_hook_node18',
  'package',
  'package_windows',
  'layout_oracle',
  'dependency_isolation'
]

const ALWAYS_ON_CODE_JOBS = new Set(['static_analysis', 'typecheck', 'test'])

const MOBILE_CI_TOOL_FILES = new Set([
  '.github/workflows/mobile.yml',
  'config/mobile-ci.vitest.config.mjs',
  'config/scripts/run-mobile-ci-tests.mjs',
  'config/scripts/mobile-release-check-scope.test.mjs',
  'config/scripts/mobile-test-change-scope.test.mjs'
])

const GLOBAL_FORCE_PREFIXES = [
  '.github/workflows/pr.yml',
  '.github/actions/install-node-dependencies/',
  '.github/actions/setup-pnpm/',
  '.github/actions/restore-pnpm-verification/',
  '.github/actions/prepare-native-runtime/',
  'config/scripts/pr-code-change-scope',
  'config/scripts/pr-package-test-paths'
]

const GLOBAL_FORCE_FILES = new Set(['package.json', 'pnpm-lock.yaml'])

const GIT_COMPAT_PREFIXES = [
  '.github/actions/prepare-git-compatibility/',
  'src/shared/git-',
  'src/shared/review-head-tracking-ref',
  'src/shared/worktree/local-base-branch-fast-forward',
  'src/main/git/',
  'config/scripts/git-binary-compatibility'
]

// Why narrow: the contract pins Codex's read-repair, so it runs when the heal that
// depends on it, its app-server transport, or the contract itself changes. The same
// job pins --no-daemon for Orca's codex shell wrapper, the project-trust key, and the
// approval Orca writes for its hook entry in managed Codex homes and ~/.codex.
const CODEX_INDEX_HEAL_CONTRACT_PREFIXES = [
  'src/main/codex/codex-hook-file-entry-binary-contract',
  'src/main/codex/codex-hook-trust-',
  'src/main/codex/codex-hook-approval-first-write',
  'src/main/codex/codex-hook-hash-lookup',
  'src/main/codex/codex-hook-orca-approvals',
  'src/main/codex/codex-hook-reconcile',
  'src/main/codex/codex-hook-local-install',
  'src/main/codex/codex-hook-user-mirroring',
  'src/main/codex/codex-real-home-hook-',
  'src/main/codex/codex-real-home-hooks-json',
  'src/main/codex/codex-user-hook-trust-moves',
  'src/main/codex/codex-hook-definition',
  'src/main/codex/codex-hook-command-form',
  'src/main/codex/codex-hook-identity',
  'src/main/codex/codex-app-server-client',
  'src/main/codex/codex-trust-identity',
  'src/main/codex/config-toml-hook-trust-',
  'src/main/codex/config-toml-key-path',
  'src/main/agent-hooks/posix-hook-command',
  'src/main/agent-hooks/hook-post-command',
  'src/main/codex-cli/codex-read-only-app-server-args',
  'src/main/agent-trust-presets',
  'src/main/codex/config-toml-trust',
  'src/main/pty/codex-no-daemon-binary-contract',
  'src/main/pty/codex-shell-launch-preflight',
  'src/shared/codex-shell-function',
  'src/main/codex/codex-index-heal-binary-contract',
  'src/main/codex/codex-session-index-heal',
  'src/main/codex/codex-app-server-session',
  'src/main/codex/codex-state-db',
  'src/main/sqlite/sync-database',
  'src/main/codex/codex-app-server-capability-signal',
  'src/main/provider-process/provider-process-exit-deadline',
  'src/main/provider-process/provider-process-launch',
  'src/main/provider-process/provider-record-reader',
  'src/main/codex/codex-session-backfill',
  'src/main/codex/codex-session-index-heal-state',
  'src/main/codex-cli/command',
  'src/main/win32-utils',
  'src/shared/node-cli-command-resolution',
  'src/shared/windows-batch-spawn'
]

const XTERM_PREFIXES = [
  'config/patches/xterm-upstream.json',
  'config/patches/@xterm',
  'config/patches/xterm-src/',
  'config/scripts/regenerate-xterm-patches'
]

const SHELL_PREFIXES = [
  'src/main/daemon/repro-13767-shell-ready-marker-lost-to-exec',
  'src/main/daemon/shell-ready',
  'src/main/daemon/daemon-bash-shell-ready',
  'src/main/daemon/daemon-shell-ready-wrapper',
  'src/main/daemon/node-pty-fd-leak',
  'src/main/providers/local-pty-shell-ready',
  'src/main/providers/__tests__/shell-ready-framework-example',
  'src/main/pty/',
  'src/main/shell-templates',
  'src/main/shell-startup-',
  'src/main/shell-wrapper-',
  'src/main/terminal-history-fish',
  'src/main/zsh-',
  'src/main/runtime/structured-session-cli-login-shell',
  'src/main/runtime/structured-session-login-shell-test-harness',
  'src/main/runtime/structured-session-child-env',
  'src/renderer/src/components/terminal-pane/fish-color-scheme',
  'src/shared/fish-',
  'src/shared/pty-reply-echo-shapes',
  'src/shared/startup-shell-portability',
  'src/shared/posix-command-path-lookup',
  'config/patches/node-pty@',
  'config/scripts/ensure-native-runtime',
  'config/scripts/node-pty-job-ownership'
]

const ORCAD_BROWSER_PREFIXES = [
  'src/main/orcad/external-chromium-',
  'src/main/orcad/orcad-browser-provider',
  'src/main/orcad/orcad-agent-browser-binary',
  'src/main/orcad/electron-serve-browser-process'
]

// The page bundle the desktop packages: the builder and verifier, the manifest writer and the
// packaging guard they share, the entry, the route tree it mounts, the mobile source those routes
// import, and the shell policy the render check runs the page under.
// What decides which deps each package sees; package.json and the lockfile already force every job.
const DEPENDENCY_ISOLATION_PREFIXES = [
  'pnpm-workspace.yaml',
  'config/pnpmfile.cjs',
  'config/scripts/undeclared-dependency-resolution',
  'config/build-plugins/markdown-parser-exports',
  'config/tsconfig',
  'src/packages/',
  'native/windows-registry/package.json',
  'native/windows-security/package.json'
]

const MOBILE_WEB_APP_PREFIXES = [
  '.github/scripts/prepare-ubuntu-apt.sh',
  'config/scripts/build-mobile-web-app',
  'config/scripts/run-mobile-web-app-checks',
  'src/packages/process-host/',
  'config/scripts/verify-mobile-web-app-bundle',
  'config/scripts/mobile-web-app-',
  'config/scripts/mobile-web-app/',
  'config/scripts/mobile-web-bundle-',
  'config/scripts/verify-packaged-mobile-web-bundle',
  'config/scripts/mobile-web-source-line-endings',
  'config/scripts/script-entry-detection',
  'mobile/web-entry/',
  'mobile/app/',
  'mobile/src/',
  'mobile/packages/',
  'mobile/package.json',
  'mobile/pnpm-lock.yaml',
  'mobile/modules/orca-mobile-web-shell/',
  // Chat visuals on both mobile surfaces are built from it; their in-page links check runs here.
  'src/shared/native-chat-visual-shell'
]

function changesMobileWebApp(changedFiles) {
  return changedFiles.some((file) => matchesPrefix(file, MOBILE_WEB_APP_PREFIXES))
}

const CROSS_VERSION_WIRE_PREFIXES = [
  'tests/e2e/cross-version-wire/',
  // COMPAT(legacy-relay-bridge): the bridge is proven against a real 1.4.224 relay here.
  'src/main/ssh/legacy-relay/',
  'config/scripts/stable-release-tags',
  // The R1 daemon protocol crossing gate runs in this job.
  'config/scripts/daemon-protocol-facts',
  'config/scripts/check-daemon-protocol-crossing',
  // R3 runtime launcher protocol ratchet; a bump always routes here via the protocol file.
  'config/scripts/check-runtime-launcher-protocol-ratchet',
  'src/main/daemon/daemon-protocol-version.ts',
  'src/shared/protocol-version',
  'src/shared/terminal-stream-protocol',
  'src/shared/browser-client-host-protocol',
  'src/shared/browser-network-tunnel-protocol',
  // The released and current WebSocket transports both accept the web upgrade marker
  // (cross-version-web-upgrade-marker).
  'src/main/runtime/rpc/ws-transport.ts',
  'src/shared/web-origin-security.ts',
  'src/shared/browser-client-host-placement',
  'src/shared/agent-launch-intent',
  'src/shared/rpc-contract/agent-launch-params',
  'src/shared/agent-session-wire',
  'src/shared/agent-session-mutation-envelope',
  // The send a client builds (the agent-session suite sends it to the release host) and the
  // fingerprint the host's ledger and journal re-derive.
  'src/shared/structured-agent-session-mutation.ts',
  'src/shared/structured-agent-session-send-mutation.ts',
  'src/shared/agent-session-record',
  'src/shared/agent-session-provider-handle',
  'src/shared/agent-session-journal-',
  'src/main/ai-vault/structured-session-ownership.ts',
  'src/main/native-chat/agent-session-journal/',
  'src/main/native-chat/agent-session-wire/',
  // The released phone contract runs the current discovery owner and Claude producer.
  'src/main/native-chat/agent-model-catalog/agent-model-catalog-entry.ts',
  'src/main/native-chat/agent-model-catalog/agent-model-catalog-store.ts',
  'src/main/native-chat/agent-model-catalog/agent-model-catalog-service.ts',
  'src/main/native-chat/agent-model-catalog/agent-model-catalog-lister.ts',
  'src/main/native-chat/agent-model-catalog/agent-model-catalog-listing-waiters.ts',
  'src/main/native-chat/agent-model-catalog/agent-model-catalog-probe-runner.ts',
  'src/main/claude/claude-model-catalog-probe.ts',
  'src/main/runtime/agent-session-record-store',
  'src/main/runtime/agent-session-recovery-capsule',
  'src/shared/agent-session-resume-marker',
  'src/main/runtime/rpc/dispatcher',
  // Run on every request the suites dispatch, whatever its method.
  'src/main/runtime/rpc/core.ts',
  'src/main/runtime/rpc/errors.ts',
  'src/main/runtime/rpc/orchestration-contract-fence.ts',
  'src/main/runtime/rpc/orchestration-session-caller.ts',
  'src/main/runtime/rpc/orchestration-legacy-compatibility.ts',
  'src/main/runtime/rpc/orchestration-mutation-executor.ts',
  'src/shared/orchestration-rpc-contract.ts',
  'src/main/runtime/rpc/methods/agent-launch',
  'src/main/runtime/rpc/methods/ai-vault.ts',
  'src/shared/rpc-contract/browser-tab-create-params',
  'src/main/runtime/rpc/methods/session-tabs.ts',
  'src/main/runtime/rpc/methods/structured-agent-session',
  'src/main/runtime/rpc/methods/terminal',
  'src/main/runtime/runtime-worktree-agent-',
  'src/main/runtime/runtime-worktree-pty-agent-sources',
  'src/shared/runtime-worktree-contracts',
  'src/renderer/src/runtime/remote-runtime-terminal-multiplexer',
  // Turn-end status a newer host publishes and an older desktop reads (cross-version-host-observed-turn-end).
  'src/shared/agent-turn-outcome',
  'src/shared/agent-status-types',
  'src/shared/agent-lead-status-fold',
  'src/shared/agent-session-turn-record',
  'src/shared/structured-agent-session-agent-status',
  'src/shared/structured-agent-session-projection',
  'src/shared/workspace-session-sleeping-agents',
  // A current desktop's launch route against a released server's capabilities (cross-version-paired-structured-launch).
  'src/shared/structured-native-chat-launch-route.ts',
  'src/renderer/src/lib/agent-launch-routing.ts',
  'src/renderer/src/runtime/paired-host-client-capabilities.ts',
  'src/shared/electron-remote-runtime-client-capabilities.ts',
  'src/shared/remote-runtime-client-capabilities.ts',
  // An older app opening a newer orchestration database (orchestration-delivery-downgrade).
  'src/main/runtime/orchestration/db.ts',
  'src/main/runtime/orchestration/db/',
  'src/main/runtime/orchestration/orchestration-schema-version-skew'
]

const MANAGED_HOOK_PREFIXES = [
  'config/scripts/smoke-process-host-node18',
  'config/scripts/packaged-process-host-fixture',
  'src/packages/process-host/',
  'config/scripts/build-wsl-guest',
  'src/wsl-guest/',
  'src/shared/agent-hook',
  'src/main/agent-hooks/'
]

const NATIVE_RUNTIME_PREFIXES = [
  'config/scripts/ensure-native-runtime',
  'config/scripts/initialize-windows-native-toolchain',
  'config/scripts/capture-windows-native-environment',
  'config/scripts/rebuild-native-deps',
  'config/scripts/node-pty-job-ownership',
  'config/scripts/windows-pe-machine',
  'config/scripts/windows-pe-image-fixture',
  'config/scripts/script-module-dependencies',
  'config/scripts/windows-process-tree-creation-time',
  'config/scripts/windows-process-tree-gyp-rebuild',
  'config/scripts/electron-builder-native-rebuild',
  'config/scripts/native-build-entry',
  'config/scripts/shared-native-build',
  'config/patches/node-pty@',
  'config/patches/@vscode__windows-process-tree'
]

const NATIVE_CACHE_FILES = new Set([
  'package.json',
  'pnpm-lock.yaml',
  '.github/actions/install-node-dependencies/action.yml',
  '.github/actions/prepare-native-runtime/action.yml',
  'pnpm-workspace.yaml',
  '.npmrc',
  'config/pnpmfile.cjs',
  'config/scripts/ensure-native-runtime.mjs',
  'config/scripts/initialize-windows-native-toolchain.mjs',
  'config/scripts/capture-windows-native-environment.cmd',
  'config/scripts/rebuild-native-deps.mjs',
  'config/scripts/node-pty-job-ownership.cjs',
  'config/scripts/windows-pe-machine.cjs',
  'config/scripts/windows-process-tree-gyp-rebuild.mjs',
  'config/scripts/windows-process-tree-creation-time.cjs',
  'config/scripts/install-electron-package-binary.mjs',
  'config/scripts/electron-platform-path.mjs',
  'config/scripts/zip-extractor-command.mjs',
  'src/shared/zip-extractor-command.ts',
  'config/scripts/shared-electron-dist-cache.mjs',
  'config/scripts/shared-tree-publish.mjs',
  'config/scripts/space-sharing-copy.mjs',
  'config/scripts/native-build-entry.cjs',
  'config/scripts/native-build-entry-probe.cjs',
  'config/scripts/shared-native-build.mjs'
])

const NATIVE_CACHE_PREFIXES = [
  'config/patches/node-pty@',
  'config/patches/@vscode__windows-process-tree',
  // The vendored addons' sources: build/ and bin/ beside them are ignored, so nothing else lands here.
  'native/windows-registry/',
  'native/windows-security/'
]

const SHARED_PACKAGE_PREFIXES = [
  'electron.vite.config.ts',
  'config/electron-builder',
  'config/packaged-runtime',
  'config/packaged-native-build-entries',
  'config/build-plugins/',
  'config/scripts/build-',
  'config/scripts/smoke-packaged',
  'config/scripts/install-electron-package-binary',
  'config/scripts/verify-packaged',
  'config/scripts/verify-skills-cli-runtime',
  'config/scripts/verify-linux-glibc',
  'config/scripts/run-electron-vite',
  'skills/',
  'skill-guides/',
  'resources/build/',
  'resources/onboarding/',
  'resources/plugins/',
  'resources/skills/',
  ...NATIVE_RUNTIME_PREFIXES
]

const LINUX_PACKAGE_PREFIXES = [
  ...SHARED_PACKAGE_PREFIXES,
  'config/scripts/package-linux-formats',
  'config/scripts/process-failure-message.mjs',
  'config/scripts/space-sharing-copy.mjs',
  '.github/actions/prepare-linux-package-fixture/',
  '.github/actions/prepare-wayland-clipboard/',
  'config/docker/cli-launch-contract/',
  'config/docker/headless-pairing/',
  'config/docker/headless-serve-shutdown/',
  'config/docker/daemon-shutdown-descendants/',
  'config/scripts/run-linux-cli-launch-contract',
  'config/scripts/run-headless-linux-pairing-docker',
  'config/scripts/run-daemon-shutdown-descendants-docker',
  'config/scripts/static-appimage-package-contract',
  'native/computer-use-linux/',
  'native/wayland-clipboard/',
  'resources/linux/',
  'config/scripts/run-headless-serve'
]

const WINDOWS_PACKAGE_PREFIXES = [
  ...SHARED_PACKAGE_PREFIXES,
  'native/windows-cli-launcher/',
  'native/windows-agent-hook/',
  'native/computer-use-windows/',
  'resources/win32/',
  'config/scripts/build-windows-cli-launcher',
  'config/scripts/build-windows-agent-hook',
  'config/scripts/windows-rust-executable-build',
  'config/scripts/verify-packaged-windows-agent-hook',
  'config/scripts/windows-pty-native-capability',
  'tests/tools/windows-pty-native-capability-smoke/'
]

const DESKTOP_IRRELEVANT_PREFIXES = [
  'mobile/',
  'cloud/',
  '.github/workflows/cloud-',
  '.github/workflows/mobile.yml',
  '.github/workflows/mobile-ios-release.yml',
  '.github/workflows/mobile-android-release.yml'
]

const STATIC_ANALYSIS_AUDIT_SCRIPTS = [
  'audit:code-quality:native',
  'audit:code-quality:type-aware',
  'audit:anti-slop'
]

// Positional arguments of an oxlint invocation are the trees it lints. `--config` consumes the
// next token; every other flag here is valueless.
function oxlintScanRoots(command) {
  const roots = []
  for (const segment of command.split('&&')) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean)
    if (tokens[0] !== 'oxlint') {
      continue
    }
    for (let index = 1; index < tokens.length; index += 1) {
      if (tokens[index] === '--config') {
        index += 1
      } else if (!tokens[index].startsWith('-')) {
        roots.push(tokens[index])
      }
    }
  }
  return roots
}

// Why derived from the commands rather than listed here: `mobile/` is desktop-irrelevant for every
// other job, yet these audits lint it. A second, hand-maintained copy of "which trees the gate
// reads" is what let #20702 land violations no PR check ran, so read it off the argv instead.
function readStaticAnalysisScanRoots() {
  const manifest = join(import.meta.dirname, '../../package.json')
  const { scripts = {} } = JSON.parse(readFileSync(manifest, 'utf8'))
  return [
    ...new Set(
      STATIC_ANALYSIS_AUDIT_SCRIPTS.flatMap((name) => oxlintScanRoots(scripts[name] ?? ''))
    )
  ]
}

export const STATIC_ANALYSIS_SCAN_ROOTS = readStaticAnalysisScanRoots()

const STATIC_ANALYSIS_SCAN_PREFIXES = STATIC_ANALYSIS_SCAN_ROOTS.map((root) => `${root}/`)

// Over-inclusive on purpose: a type oxfmt skips only costs this PR a static run.
const FORMAT_CHECKED_EXTENSION =
  /\.(?:[cm]?[jt]sx?|json[c5]?|css|less|scss|md|mdx|ya?ml|vue|html|graphql|gql|toml)$/i

function readFormatIgnoredPrefixes() {
  let config
  try {
    config = JSON.parse(readFileSync(join(import.meta.dirname, '../../.oxfmtrc.json'), 'utf8'))
  } catch {
    // Fail closed: with no ignores known, every formatted type keeps the gate.
    return []
  }
  return (config.ignorePatterns ?? [])
    .filter((pattern) => pattern.endsWith('/**'))
    .map((pattern) => pattern.slice(0, -2))
}

const FORMAT_IGNORED_PREFIXES = readFormatIgnoredPrefixes()

export function isDocsOnlyPath(file) {
  return (
    DOCS_ONLY_FILES.has(file) ||
    DOCS_ONLY_PREFIXES.some((prefix) => file.startsWith(prefix)) ||
    /^README\.[^/]+\.md$/.test(file)
  )
}

export function shouldRunPrChecks(changedFiles) {
  // Why empty-run: a silent empty diff is more likely a detector bug than a
  // genuine no-op PR, so fail closed and keep the expensive jobs.
  if (changedFiles.length === 0) {
    return true
  }
  return changedFiles.some((file) => !isDocsOnlyPath(file) && !isDesktopIrrelevantPath(file))
}

export function needsMobileDependencies(changedFiles) {
  // Why: static analysis lints CHANGED files, mobile ones included, and its
  // type-aware pass resolves types from mobile/node_modules. Mobile is a
  // separate pnpm project, so without this the root-only install leaves every
  // mobile type an `error` type and the gate reports phantom findings.
  return changedFiles.length === 0 || changedFiles.some((file) => file.startsWith('mobile/'))
}

export const DAEMON_INIT_TEST_SUPPORT = 'src/main/daemon/daemon-init-dependency-mocks.ts'

const DAEMON_INIT_TEST_SCOPE = new Set([
  DAEMON_INIT_TEST_SUPPORT,
  'src/main/native-chat/agent-session-wire/structured-agent-session-claude-queued-stop.test.ts',
  'config/scripts/process-host-build-dist.test.mjs',
  'src/main/codex/codex-app-server-connection.test.ts'
])

export function isDaemonInitTestSupportChange(files, modifiedOnly = false) {
  return (
    modifiedOnly &&
    files.includes(DAEMON_INIT_TEST_SUPPORT) &&
    new Set(files).size === files.length &&
    files.every((file) => DAEMON_INIT_TEST_SCOPE.has(file))
  )
}

export function classifyPrJobs(
  changedFiles,
  { allowMobileCiTools = false, allowDaemonInitTestSupport = false } = {}
) {
  const emptyDiff = changedFiles.length === 0
  const shouldRun = shouldRunPrChecks(changedFiles)
  const forceAll = emptyDiff || changedFiles.some(isGlobalForcePath)
  const bundleFiles = isDaemonInitTestSupportChange(changedFiles, allowDaemonInitTestSupport)
    ? changedFiles.filter((file) => file !== DAEMON_INIT_TEST_SUPPORT)
    : changedFiles
  const jobs = Object.fromEntries(
    PR_CHECK_JOBS.map((job) => [
      job,
      shouldRun &&
        (forceAll ||
          ALWAYS_ON_CODE_JOBS.has(job) ||
          jobDetector(job)(
            ['package', 'package_windows'].includes(job) ? bundleFiles : changedFiles
          ))
    ])
  )
  // Why outside should_run: a mobile-only diff is desktop-irrelevant and skips every job above,
  // but the repo-wide audits lint mobile/, and skipping them lands the violation on main, where
  // it then fails this same gate on every later PR's merge ref.
  // Why formatted paths too: the formatting check reads the whole tree, so a docs-only diff that
  // skipped it would land drift that then fails every later PR.
  jobs.static_analysis =
    jobs.static_analysis ||
    changedFiles.some((file) => isStaticAnalysisScannedPath(file) || isFormatCheckedPath(file))
  // Why outside should_run, for the same reason: a mobile-only diff is desktop-irrelevant, and
  // that is exactly the diff that changes the page this job builds. Gated on should_run it would
  // skip on every PR that can break it and run on none.
  jobs.mobile_web_app = jobs.mobile_web_app || changesMobileWebApp(changedFiles)
  const mobileCiTools =
    allowMobileCiTools &&
    !emptyDiff &&
    jobs.test &&
    (jobs.static_analysis || jobs.typecheck) &&
    changedFiles.every((file) => MOBILE_CI_TOOL_FILES.has(file))
  return {
    should_run: shouldRun,
    mobile_ci_tools: mobileCiTools,
    windows_process_probe: shouldRun && (forceAll || changedFiles.some(isWindowsProcessProbePath)),
    // Relay contracts exercise host/cloud code; any input outside the renderer keeps them.
    relay_integration:
      shouldRun &&
      (forceAll ||
        changedFiles.some((file) => !file.startsWith('src/renderer/') && !isDocsOnlyPath(file))),
    native_cache_changed: shouldRun && (emptyDiff || changedFiles.some(isNativeCacheInputPath)),
    mobile_dependencies:
      (shouldRun || jobs.static_analysis) && needsMobileDependencies(changedFiles),
    ...jobs
  }
}

function jobDetector(job) {
  switch (job) {
    case 'git_compatibility':
      return (files) => files.some((file) => matchesPrefix(file, GIT_COMPAT_PREFIXES))
    case 'codex_index_heal_contract':
      return (files) =>
        files.some(
          (file) =>
            !/^src\/main\/codex\/codex-app-server-(client|session)\.test\.ts(?!.)/s.test(file) &&
            matchesPrefix(file, CODEX_INDEX_HEAL_CONTRACT_PREFIXES)
        )
    case 'xterm_patch_sync':
      return (files) => files.some((file) => matchesPrefix(file, XTERM_PREFIXES))
    case 'shell_contracts':
      return (files) => files.some((file) => matchesPrefix(file, SHELL_PREFIXES))
    case 'orcad_browser':
      return (files) => files.some((file) => matchesPrefix(file, ORCAD_BROWSER_PREFIXES))
    // Not redundant with the lift below the jobs map: without a case here the default detector
    // returns true, which would run this job on every desktop-relevant PR.
    case 'mobile_web_app':
      return changesMobileWebApp
    case 'cross-version-wire':
      return (files) => files.some((file) => matchesPrefix(file, CROSS_VERSION_WIRE_PREFIXES))
    case 'managed_hook_node18':
      return (files) => files.some((file) => matchesPrefix(file, MANAGED_HOOK_PREFIXES))
    case 'package':
      return (files) => files.some(isLinuxPackagePath)
    case 'package_windows':
      return (files) => files.some(isWindowsPackagePath)
    case 'layout_oracle':
      return (files) => files.some(isLayoutOracleSource)
    case 'dependency_isolation':
      return (files) => files.some((file) => matchesPrefix(file, DEPENDENCY_ISOLATION_PREFIXES))
    default:
      return () => true
  }
}

function isLinuxPackagePath(file) {
  return LINUX_PACKAGE_TESTS.includes(file) || isProductBundlePath(file, LINUX_PACKAGE_PREFIXES)
}

function isWindowsPackagePath(file) {
  return (
    WINDOWS_PACKAGE_TESTS.includes(file) ||
    isWindowsProcessProbePath(file) ||
    isProductBundlePath(file, WINDOWS_PACKAGE_PREFIXES)
  )
}

function isProductBundlePath(file, extraPrefixes) {
  if (isTestFile(file)) {
    return false
  }
  return file.startsWith('src/') || matchesPrefix(file, extraPrefixes)
}

// These shared fixtures are consumed only by unit tests.
export function isUnitTestSupportSource(file) {
  return (
    file === 'src/renderer/src/store/slices/editor-slice-test-harness.ts' ||
    file === 'src/renderer/src/store/slices/browser-slice-test-harness.ts' ||
    file === 'src/renderer/src/runtime/web-runtime-session-test-harness.ts' ||
    file === 'src/renderer/src/runtime/sync-runtime-graph-test-harness.ts' ||
    file === 'src/renderer/src/runtime/web-session-tabs-sync-test-harness.ts' ||
    file === 'src/renderer/src/components/native-chat/NativeChatStructuredSession.test-harness.tsx'
  )
}

function isTestFile(file) {
  return (
    isUnitTestSupportSource(file) ||
    /\.(?:test|spec)\.(?:js|cjs|mjs|ts|tsx)$/.test(file) ||
    file.includes('/__tests__/')
  )
}

function isDesktopIrrelevantPath(file) {
  return matchesPrefix(file, DESKTOP_IRRELEVANT_PREFIXES)
}

function isStaticAnalysisScannedPath(file) {
  // Fail closed: roots we failed to parse must keep the gate, not silently drop it.
  return (
    STATIC_ANALYSIS_SCAN_PREFIXES.length === 0 || matchesPrefix(file, STATIC_ANALYSIS_SCAN_PREFIXES)
  )
}

function isFormatCheckedPath(file) {
  return FORMAT_CHECKED_EXTENSION.test(file) && !matchesPrefix(file, FORMAT_IGNORED_PREFIXES)
}

function isNativeCacheInputPath(file) {
  return NATIVE_CACHE_FILES.has(file) || matchesPrefix(file, NATIVE_CACHE_PREFIXES)
}

function isGlobalForcePath(file) {
  return (
    GLOBAL_FORCE_FILES.has(file) ||
    (matchesPrefix(file, GLOBAL_FORCE_PREFIXES) &&
      !(file.startsWith('config/scripts/') && isTestFile(file)))
  )
}

function matchesPrefix(file, prefixes) {
  return prefixes.some((prefix) => file === prefix || file.startsWith(prefix))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Why streamed, not readFileSync(0): a single read of fd 0 throws EAGAIN once the writer
  // outgrows the 64 KB pipe buffer, which a stale PR base.sha reaches easily.
  let input = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) {
    input += chunk
  }
  const classification = classifyPrJobs(input.split(/\r?\n/).filter(Boolean), {
    allowMobileCiTools: process.argv.includes('--mobile-ci-tools'),
    allowDaemonInitTestSupport: process.argv.includes('--daemon-init-test-support')
  })
  for (const [name, value] of Object.entries(classification)) {
    process.stdout.write(`${name}=${value ? 'true' : 'false'}\n`)
  }
}
