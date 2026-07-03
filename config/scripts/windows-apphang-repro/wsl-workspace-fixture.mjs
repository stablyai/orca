import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)))

function runWsl(distro, script, options = {}) {
  return execFileSync('wsl.exe', ['-d', distro, '--', 'bash', '-se'], {
    cwd: rootDir,
    encoding: 'utf8',
    input: script,
    timeout: options.timeoutMs ?? 120_000,
    stdio: ['pipe', 'pipe', 'pipe']
  })
}

export function listWslDistros() {
  const output = execFileSync('wsl.exe', ['--list', '--quiet'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000
  })
  return output
    .replaceAll(String.fromCharCode(0), '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^\*\s*/, ''))
    .filter((line) => line && !line.toLowerCase().startsWith('docker-desktop'))
}

function linuxPathToWslUnc(distro, linuxPath) {
  if (!linuxPath.startsWith('/')) {
    throw new Error(`Expected absolute Linux path, got ${linuxPath}`)
  }
  return `\\\\wsl.localhost\\${distro}${linuxPath.replace(/\//g, '\\')}`
}

export function createWslFixture(distro) {
  const script = String.raw`
set -euo pipefail
base="$(mktemp -d /tmp/orca-apphang-repro.XXXXXX)"
repo="$base/repo"
mkdir -p "$repo"
cd "$repo"
git init -q
git config user.email apphang-repro@test.local
git config user.name "AppHang Repro"
mkdir -p src docs
printf '# Orca Windows AppHang repro\n' > README.md
for n in $(seq 1 25); do
  printf 'line %03d %s\n' "$n" "abcdefghijklmnopqrstuvwxyz0123456789" >> src/payload.txt
done
git add -A
git commit -q -m "Initial repro fixture"
for n in 1 2 3 4; do
  git branch "repro-wt-$n"
  git worktree add -q "$base/wt-$n" "repro-wt-$n"
  mkdir -p "$base/wt-$n/docs"
  printf 'worktree %s\n' "$n" > "$base/wt-$n/docs/wt.txt"
done
plain="$base/plain-folder"
mkdir -p "$plain/subdir"
printf 'plain folder for Orca AppHang repro\n' > "$plain/README.txt"
printf '%s\n' "$base" "$repo" "$base/wt-1" "$base/wt-2" "$base/wt-3" "$base/wt-4" "$plain"
`
  const lines = runWsl(distro, script, { timeoutMs: 120_000 }).trim().split(/\r?\n/).filter(Boolean)
  if (lines.length < 7) {
    throw new Error(`WSL fixture creation returned unexpected output: ${JSON.stringify(lines)}`)
  }
  const [base, repo, ...rest] = lines
  const plain = rest.at(-1)
  const worktrees = rest.slice(0, -1)
  return {
    distro,
    baseLinuxPath: base,
    repoLinuxPath: repo,
    plainLinuxPath: plain,
    worktreeLinuxPaths: worktrees,
    repoUncPath: linuxPathToWslUnc(distro, repo),
    plainUncPath: linuxPathToWslUnc(distro, plain),
    worktreeUncPaths: worktrees.map((entry) => linuxPathToWslUnc(distro, entry))
  }
}

export function removeWslFixture(fixture) {
  if (!fixture?.baseLinuxPath) {
    return
  }
  const quoted = fixture.baseLinuxPath.replaceAll("'", "'\\''")
  runWsl(fixture.distro, `rm -rf '${quoted}'`, { timeoutMs: 30_000 })
}

export function createCompletedOnboardingProfile(userDataDir) {
  mkdirSync(userDataDir, { recursive: true })
  const profile = {
    settings: {
      telemetry: {
        // Why: synthetic harness/benchmark activity must not send telemetry.
        // Explicit false with existedBeforeTelemetryRelease=false also keeps
        // the first-launch consent surface from blocking automation.
        optedIn: false,
        installId: '00000000-0000-4000-8000-000000000000',
        existedBeforeTelemetryRelease: false
      }
    },
    onboarding: {
      flowVersion: 4,
      closedAt: 1,
      outcome: 'completed',
      lastCompletedStep: 5
    },
    ui: {
      contextualToursAutoEligible: false,
      contextualToursSeenIds: [
        'workspace-board',
        'browser',
        'tasks',
        'automations',
        'workspace-creation'
      ],
      featureTipsSeenIds: [],
      featureInteractions: {},
      projectOrderManualDefaultNoticeDismissed: true
    }
  }
  writeFileSync(path.join(userDataDir, 'orca-data.json'), `${JSON.stringify(profile, null, 2)}\n`)
}

export function safeRemoveLocalDirectory(dir, cleanupErrors) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch (error) {
    cleanupErrors.push(error instanceof Error ? error.message : String(error))
  }
}
