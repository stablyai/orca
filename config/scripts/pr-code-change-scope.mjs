import { readFileSync } from 'node:fs'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

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
  'cross-version-wire',
  'managed_hook_node18',
  'package',
  'package_windows'
]

const ALWAYS_ON_CODE_JOBS = new Set(['static_analysis', 'typecheck', 'test'])

const GLOBAL_FORCE_PREFIXES = [
  '.github/workflows/pr.yml',
  '.github/actions/install-node-dependencies/',
  'config/scripts/pr-code-change-scope'
]

const GLOBAL_FORCE_FILES = new Set(['package.json', 'pnpm-lock.yaml'])

const GIT_COMPAT_PREFIXES = [
  'src/shared/git-',
  'src/shared/review-head-tracking-ref',
  'src/main/git/',
  'src/relay/git-',
  'config/scripts/git-binary-compatibility'
]

// Why narrow: the contract pins Codex's read-repair, so it runs when the heal that
// depends on it, its app-server transport, or the contract itself changes.
const CODEX_INDEX_HEAL_CONTRACT_PREFIXES = [
  'src/main/codex/codex-index-heal-binary-contract',
  'src/main/codex/codex-session-index-heal',
  'src/main/codex/codex-app-server-session',
  'src/main/codex/codex-state-db',
  'src/main/sqlite/sync-database',
  'src/main/codex/codex-app-server-capability-signal',
  'src/main/codex/codex-process-exit-deadline',
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

const CROSS_VERSION_WIRE_PREFIXES = [
  'tests/e2e/cross-version-wire/',
  'src/shared/protocol-version',
  'src/shared/terminal-stream-protocol',
  'src/shared/browser-client-host-protocol',
  'src/shared/browser-network-tunnel-protocol',
  'src/shared/browser-client-host-placement',
  'src/shared/agent-session-wire',
  'src/shared/agent-session-mutation-envelope',
  'src/shared/agent-session-journal-',
  'src/main/ai-vault/structured-session-ownership.ts',
  'src/main/native-chat/agent-session-journal/',
  'src/main/native-chat/agent-session-wire/',
  'src/main/runtime/agent-session-record-store',
  'src/main/runtime/rpc/dispatcher',
  'src/main/runtime/rpc/methods/ai-vault.ts',
  'src/main/runtime/rpc/methods/browser-tab-create-schema',
  'src/main/runtime/rpc/methods/session-tabs.ts',
  'src/main/runtime/rpc/methods/structured-agent-session',
  'src/main/runtime/rpc/methods/terminal',
  'src/renderer/src/runtime/remote-runtime-terminal-multiplexer'
]

const MANAGED_HOOK_PREFIXES = [
  'config/scripts/smoke-managed-hook-runtime-node18',
  'config/scripts/build-relay',
  'src/relay/',
  'src/shared/agent-hook',
  'src/main/agent-hooks/'
]

const NATIVE_RUNTIME_PREFIXES = [
  'config/scripts/ensure-native-runtime',
  'config/scripts/rebuild-native-deps',
  'config/scripts/node-pty-job-ownership',
  'config/scripts/electron-builder-native-rebuild',
  'config/patches/node-pty@',
  'config/patches/@vscode__windows-process-tree'
]

const NATIVE_CACHE_FILES = new Set([
  'package.json',
  'pnpm-lock.yaml',
  '.github/actions/install-node-dependencies/action.yml',
  'config/scripts/ensure-native-runtime.mjs',
  'config/scripts/rebuild-native-deps.mjs'
])

const NATIVE_CACHE_PREFIXES = [
  'config/patches/node-pty@',
  'config/patches/@vscode__windows-process-tree'
]

const SHARED_PACKAGE_PREFIXES = [
  'electron.vite.config.ts',
  'config/electron-builder',
  'config/packaged-runtime',
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
  'config/docker/cli-launch-contract/',
  'config/docker/headless-pairing/',
  'config/docker/headless-serve-shutdown/',
  'config/scripts/run-linux-cli-launch-contract',
  'config/scripts/run-headless-linux-pairing-docker',
  'config/scripts/static-appimage-package-contract',
  'native/computer-use-linux/',
  'resources/linux/',
  'config/scripts/run-headless-serve'
]

const WINDOWS_PACKAGE_PREFIXES = [
  ...SHARED_PACKAGE_PREFIXES,
  'native/windows-cli-launcher/',
  'native/computer-use-windows/',
  'resources/win32/',
  'config/scripts/build-windows-cli-launcher',
  'config/scripts/windows-pty-native-capability',
  'tests/tools/windows-pty-native-capability-smoke/'
]

const LINUX_PACKAGE_TESTS = [
  'src/main/browser/browser-client-page-renderer-lifecycle.electron.test.ts',
  'src/main/browser/browser-route-tcp-egress.electron.test.ts',
  'src/main/browser/browser-route-webrtc-egress.electron.test.ts',
  'src/main/browser/browser-route-h3-egress.electron.test.ts',
  'src/main/browser/browser-route-dns-prefetch.electron.test.ts'
]

const WINDOWS_PACKAGE_TESTS = [
  ...LINUX_PACKAGE_TESTS,
  'config/scripts/rebuild-native-deps.test.mjs',
  'src/main/providers/windows-conpty-wide-char-duplication.node-pty.test.ts',
  'src/main/providers/pty-repaint-wide-char-buffer.node-pty.test.ts',
  'src/shared/child-process/windows-command-line.win32.test.ts',
  'src/main/agent-hooks/windows-hook-payload-delivery.test.ts',
  'src/main/windows/windows-pty-job.win32.test.ts',
  'src/main/windows/windows-host-job.win32.test.ts',
  'src/main/wsl/wsl-runner.test.ts',
  'src/main/wsl/wsl-guest-environment.test.ts',
  'src/main/wsl/wsl-invocation-boundary.test.ts',
  'src/main/wsl/wsl-executable-path.win32.test.ts',
  'src/main/wsl/wsl-w1-w3-contract.test.ts',
  'src/shared/source-scan/source-tree-scan.test.ts',
  'src/main/cli/wsl-cli-powershell-boundary.test.ts',
  'src/main/cursor/hook-service.test.ts',
  'src/main/orca-profiles/profile-index-store.test.ts',
  'src/main/runtime/repo-worktree-admin-fingerprint.test.ts',
  'src/main/runtime/worktree-scan-admin-fingerprint-gate.test.ts',
  'src/shared/secure-file-fsync-flags.test.ts',
  'src/main/ipc/pty-codex-account-attribution.test.ts',
  'src/main/ipc/pty-spawn-env-codex-resume-provenance.test.ts'
]

const DESKTOP_IRRELEVANT_PREFIXES = [
  'mobile/',
  'cloud/',
  '.github/workflows/cloud-',
  '.github/workflows/mobile.yml',
  '.github/workflows/mobile-ios-release.yml',
  '.github/workflows/mobile-android-release.yml'
]

export function isDocsOnlyPath(file) {
  if (DOCS_ONLY_FILES.has(file)) {
    return true
  }
  if (DOCS_ONLY_PREFIXES.some((prefix) => file.startsWith(prefix))) {
    return true
  }
  return /^README\.[^/]+\.md$/.test(file)
}

export function shouldRunPrChecks(changedFiles) {
  // Why empty-run: a silent empty diff is more likely a detector bug than a
  // genuine no-op PR, so fail closed and keep the expensive jobs.
  if (changedFiles.length === 0) {
    return true
  }
  return changedFiles.some((file) => !isDocsOnlyPath(file) && !isDesktopIrrelevantPath(file))
}

export function classifyPrJobs(changedFiles) {
  const emptyDiff = changedFiles.length === 0
  const shouldRun = shouldRunPrChecks(changedFiles)
  const forceAll = emptyDiff || changedFiles.some(isGlobalForcePath)
  const jobs = Object.fromEntries(
    PR_CHECK_JOBS.map((job) => [
      job,
      shouldRun && (forceAll || ALWAYS_ON_CODE_JOBS.has(job) || jobDetector(job)(changedFiles))
    ])
  )
  return {
    should_run: shouldRun,
    native_cache_changed: shouldRun && (emptyDiff || changedFiles.some(isNativeCacheInputPath)),
    ...jobs
  }
}

function jobDetector(job) {
  switch (job) {
    case 'git_compatibility':
      return (files) => files.some((file) => matchesPrefix(file, GIT_COMPAT_PREFIXES))
    case 'codex_index_heal_contract':
      return (files) =>
        files.some((file) => matchesPrefix(file, CODEX_INDEX_HEAL_CONTRACT_PREFIXES))
    case 'xterm_patch_sync':
      return (files) => files.some((file) => matchesPrefix(file, XTERM_PREFIXES))
    case 'shell_contracts':
      return (files) => files.some((file) => matchesPrefix(file, SHELL_PREFIXES))
    case 'orcad_browser':
      return (files) => files.some((file) => matchesPrefix(file, ORCAD_BROWSER_PREFIXES))
    case 'cross-version-wire':
      return (files) => files.some((file) => matchesPrefix(file, CROSS_VERSION_WIRE_PREFIXES))
    case 'managed_hook_node18':
      return (files) => files.some((file) => matchesPrefix(file, MANAGED_HOOK_PREFIXES))
    case 'package':
      return (files) => files.some(isLinuxPackagePath)
    case 'package_windows':
      return (files) => files.some(isWindowsPackagePath)
    default:
      return () => true
  }
}

function isLinuxPackagePath(file) {
  return LINUX_PACKAGE_TESTS.includes(file) || isProductBundlePath(file, LINUX_PACKAGE_PREFIXES)
}

function isWindowsPackagePath(file) {
  return WINDOWS_PACKAGE_TESTS.includes(file) || isProductBundlePath(file, WINDOWS_PACKAGE_PREFIXES)
}

function isProductBundlePath(file, extraPrefixes) {
  if (isTestFile(file)) {
    return false
  }
  if (file.startsWith('src/')) {
    return true
  }
  return matchesPrefix(file, extraPrefixes)
}

function isTestFile(file) {
  return /\.(?:test|spec)\.(?:js|cjs|mjs|ts|tsx)$/.test(file) || file.includes('/__tests__/')
}

function isDesktopIrrelevantPath(file) {
  return matchesPrefix(file, DESKTOP_IRRELEVANT_PREFIXES)
}

function isNativeCacheInputPath(file) {
  return NATIVE_CACHE_FILES.has(file) || matchesPrefix(file, NATIVE_CACHE_PREFIXES)
}

function isGlobalForcePath(file) {
  return GLOBAL_FORCE_FILES.has(file) || matchesPrefix(file, GLOBAL_FORCE_PREFIXES)
}

function matchesPrefix(file, prefixes) {
  return prefixes.some((prefix) => file === prefix || file.startsWith(prefix))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = readFileSync(0, 'utf8').split('\n').filter(Boolean)
  const classification = classifyPrJobs(files)
  for (const [name, value] of Object.entries(classification)) {
    process.stdout.write(`${name}=${value ? 'true' : 'false'}\n`)
  }
}
