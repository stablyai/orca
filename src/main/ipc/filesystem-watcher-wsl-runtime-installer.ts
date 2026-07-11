import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

export type WslWatcherManifest = {
  protocol: 1
  installLayout: 1
  nodeVersion: string
  bundleVersion: string
}

export type InstalledWslWatcherRuntime = { nodePath: string; hostPath: string }

type InstallerResponse =
  | ({ kind: 'ready' } & InstalledWslWatcherRuntime)
  | { kind: 'install'; arch: 'x64' | 'arm64'; home: string }

export class WslWatcherCompatibilityError extends Error {}

export const PROBE_BUNDLE_SENTINEL = '-'

export const INSTALL_SCRIPT = String.raw`
set -eu; mode=$1; version=$2; node_version=$3; bundle_linux=$4
case "$(uname -m)" in x86_64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) echo "unsupported WSL architecture: $(uname -m)" >&2; exit 70 ;; esac
glibc_info=$(getconf GNU_LIBC_VERSION 2>/dev/null) || { echo "managed WSL watcher requires a glibc distro" >&2; exit 71; }
set -- $glibc_info; glibc_version=$2
case "$glibc_version" in 0.*|1.*|2.[0-9]|2.1[0-9]|2.2[0-7]) echo "managed WSL watcher requires glibc >= 2.28 (found $glibc_version)" >&2; exit 73 ;; esac
base="$HOME/.local/share/orca/wsl-watcher"; install="$base/$version/$arch"; complete="$install/.complete"
transfer_base="$HOME/.local/share/orca/wsl-watcher-transfer"; mkdir -p "$transfer_base"; find "$transfer_base" -mindepth 1 -maxdepth 1 -type d -mmin +180 -exec rm -rf -- {} \; 2>/dev/null || true
runtime_is_valid() {
  test -x "$install/node" && test -f "$install/host.js" && test -f "$install/watcher.node" && test -f "$install/LICENSE" && test -f "$install/parcel-watcher-LICENSE" &&
  test "$(cat "$complete" 2>/dev/null || true)" = "$version" && "$install/node" "$install/host.js" --check >/dev/null 2>&1
}
prune_old_versions() {
  retained=0; ls -1dt "$base"/[0-9a-f]* 2>/dev/null | while IFS= read -r candidate; do
    test -d "$candidate" || continue; name=$(basename "$candidate")
    case "$name" in ????????????????????) ;; *) continue ;; esac; case "$name" in *[!0-9a-f]*) continue ;; esac
    locked=false; for candidate_lock in "$candidate"/.install-*.lock; do test -d "$candidate_lock" && locked=true; done
    if "$locked" || test "$retained" -lt 3; then retained=$((retained + 1)); else rm -rf -- "$candidate"; fi
  done
}
print_ready() { touch "$base/$version"; prune_old_versions; printf 'ready\n%s\n%s\n' "$install/node" "$install/host.js"; }
if runtime_is_valid; then print_ready; exit 0; fi
if test "$mode" = probe; then printf 'install\n%s\n%s\n' "$arch" "$HOME"; exit 0; fi
test "$mode" = install
archive="$bundle_linux/$arch/node.tar.xz"; watcher="$bundle_linux/$arch/watcher.node"; host="$bundle_linux/host.js"; watcher_license="$bundle_linux/parcel-watcher-LICENSE"
test -f "$archive" && test -f "$watcher" && test -f "$host" && test -f "$watcher_license"
mkdir -p "$base/$version"
lock="$base/$version/.install-$arch.lock"
lock_owner_live() {
  test -r "$lock/owner" && read -r owner owner_start <"$lock/owner" && test -r "/proc/$owner/stat" || return 1
  actual_start=$(awk '{print $22}' "/proc/$owner/stat" 2>/dev/null) && test "$actual_start" = "$owner_start"
}
attempt=0; while ! mkdir "$lock" 2>/dev/null; do
  if ! lock_owner_live && { test -r "$lock/owner" || find "$lock" -maxdepth 0 -mmin +1 -print -quit | grep -q .; }; then rm -rf -- "$lock"; continue; fi
  if runtime_is_valid; then print_ready; exit 0; fi
  attempt=$((attempt + 1)); test "$attempt" -lt 1200 || { echo "timed out waiting for WSL watcher install" >&2; exit 72; }
  sleep 0.1
done
owner_start=$(awk '{print $22}' "/proc/$$/stat"); printf '%s %s\n' "$$" "$owner_start" >"$lock/owner"
if runtime_is_valid; then rm -rf -- "$lock"; print_ready; exit 0; fi
stage="$base/version-$version-$arch-$$.tmp"; heartbeat_pid=
cleanup() { test -z "$heartbeat_pid" || { kill "$heartbeat_pid" 2>/dev/null || true; wait "$heartbeat_pid" 2>/dev/null || true; }; rm -rf -- "$stage" "$lock"; }
trap cleanup EXIT HUP INT TERM
while touch "$lock/heartbeat" 2>/dev/null; do sleep 2; done & heartbeat_pid=$!
rm -rf -- "$stage" "$install"; mkdir -p "$stage"
tar -xJf "$archive" -C "$stage" --strip-components=2 "node-v$node_version-linux-$arch/bin/node"; tar -xJf "$archive" -C "$stage" --strip-components=1 "node-v$node_version-linux-$arch/LICENSE"
cp "$host" "$stage/host.js"; cp "$watcher" "$stage/watcher.node"; cp "$watcher_license" "$stage/parcel-watcher-LICENSE"
chmod 700 "$stage/node" "$stage/host.js"; "$stage/node" "$stage/host.js" --check >/dev/null; printf '%s\n' "$version" >"$stage/.complete"
mv "$stage" "$install"; runtime_is_valid; print_ready
`

export function createWslRuntimeTransferPaths(
  distro: string,
  home: string,
  version: string,
  nonce = `${process.pid}-${randomUUID()}`,
  provider: 'wsl.localhost' | 'wsl$' = 'wsl.localhost'
): { linuxPath: string; windowsPath: string } {
  const linuxPath = `${home.replace(/\/+$/, '')}/.local/share/orca/wsl-watcher-transfer/${version}-${nonce}`
  return {
    linuxPath,
    windowsPath: `\\\\${provider}\\${distro}${linuxPath.replaceAll('/', '\\')}`
  }
}

export function createWslRuntimeCancellationError(): Error {
  return new Error('Managed WSL watcher installation cancelled')
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createWslRuntimeCancellationError()
  }
}

export function parseInstallerResponse(output: string): InstallerResponse {
  const lines = output
    .replaceAll('\0', '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines[0] === 'ready' && lines[1]?.startsWith('/') && lines[2]?.startsWith('/')) {
    return { kind: 'ready', nodePath: lines[1], hostPath: lines[2] }
  }
  if (
    lines[0] === 'install' &&
    (lines[1] === 'x64' || lines[1] === 'arm64') &&
    lines[2]?.startsWith('/')
  ) {
    return { kind: 'install', arch: lines[1], home: lines[2] }
  }
  throw new Error('Managed WSL watcher installer returned an invalid response')
}

async function stageRuntimeBundle(
  bundlePath: string,
  transferPath: string,
  arch: 'x64' | 'arm64',
  signal?: AbortSignal
): Promise<void> {
  throwIfAborted(signal)
  const archTarget = join(transferPath, arch)
  await mkdir(archTarget, { recursive: true })
  let copyFailure: { error: unknown } | undefined
  const copies = [
    copyFile(join(bundlePath, 'host.js'), join(transferPath, 'host.js')),
    copyFile(
      join(bundlePath, 'parcel-watcher-LICENSE'),
      join(transferPath, 'parcel-watcher-LICENSE')
    ),
    copyFile(join(bundlePath, arch, 'node.tar.xz'), join(archTarget, 'node.tar.xz')),
    copyFile(join(bundlePath, arch, 'watcher.node'), join(archTarget, 'watcher.node'))
  ]
  // Why: Promise.all rejects early, but cleanup or provider fallback must not
  // race sibling UNC copies that are still writing into the transfer path.
  await Promise.all(
    copies.map((copy) =>
      copy.catch((error: unknown) => {
        copyFailure ??= { error }
      })
    )
  )
  if (copyFailure) {
    throw copyFailure.error
  }
  throwIfAborted(signal)
}

async function stageRuntimeBundleWithProviders(
  distro: string,
  home: string,
  version: string,
  bundlePath: string,
  arch: 'x64' | 'arm64',
  signal?: AbortSignal
): Promise<{ linuxPath: string; transferPaths: string[] }> {
  const nonce = `${process.pid}-${randomUUID()}`
  // Why: older WSL releases may expose only the legacy UNC provider even when
  // the modern provider is unavailable for the same running distribution.
  const transfers = (['wsl.localhost', 'wsl$'] as const).map((provider) =>
    createWslRuntimeTransferPaths(distro, home, version, nonce, provider)
  )
  let lastError: unknown
  for (const transfer of transfers) {
    try {
      await stageRuntimeBundle(bundlePath, transfer.windowsPath, arch, signal)
      return {
        linuxPath: transfer.linuxPath,
        transferPaths: transfers.map((candidate) => candidate.windowsPath)
      }
    } catch (error) {
      lastError = error
      await rm(transfer.windowsPath, { recursive: true, force: true }).catch(() => undefined)
      throwIfAborted(signal)
    }
  }
  throw lastError
}

function runInstaller(distro: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal?.aborted) {
      rejectPromise(createWslRuntimeCancellationError())
      return
    }
    const child = spawn('wsl.exe', ['-d', distro, '--exec', 'sh', '-s', '--', ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    let settled = false
    const settle = (error?: Error): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error) {
        rejectPromise(error)
      } else {
        resolvePromise(stdout)
      }
    }
    const fail = (error: Error): void => {
      if (settled) {
        return
      }
      settle(error)
      child.kill()
    }
    const onAbort = (): void => fail(createWslRuntimeCancellationError())
    const timer = setTimeout(() => {
      fail(new Error(`Timed out installing managed WSL watcher for ${distro}`))
    }, 120_000)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += stdoutDecoder.write(chunk)
      if (stdout.length > 64 * 1024) {
        fail(new Error('Managed WSL watcher installer produced too much output'))
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + stderrDecoder.write(chunk)).slice(-4096)
    })
    child.stdout.on('error', fail)
    child.stderr.on('error', fail)
    child.on('error', fail)
    child.once('close', (code, signal) => {
      stdout += stdoutDecoder.end()
      stderr = (stderr + stderrDecoder.end()).slice(-4096)
      if (code === 0) {
        settle()
      } else {
        const ErrorType =
          code === 70 || code === 71 || code === 73 ? WslWatcherCompatibilityError : Error
        settle(
          new ErrorType(
            `Managed WSL watcher install failed (${code ?? signal})${stderr.trim() ? `: ${stderr.trim()}` : ''}`
          )
        )
      }
    })
    child.stdin.on('error', fail)
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdin.end(INSTALL_SCRIPT)
  })
}

export async function installWslWatcherRuntime(
  distro: string,
  bundlePath: string,
  manifest: WslWatcherManifest,
  signal?: AbortSignal
): Promise<InstalledWslWatcherRuntime> {
  throwIfAborted(signal)
  // Why: wsl.exe drops trailing empty arguments, so probe uses a non-path sentinel.
  const probeArgs = ['probe', manifest.bundleVersion, manifest.nodeVersion, PROBE_BUNDLE_SENTINEL]
  const probe = parseInstallerResponse(await runInstaller(distro, probeArgs, signal))
  if (probe.kind === 'ready') {
    return { nodePath: probe.nodePath, hostPath: probe.hostPath }
  }
  const transfer = await stageRuntimeBundleWithProviders(
    distro,
    probe.home,
    manifest.bundleVersion,
    bundlePath,
    probe.arch,
    signal
  )
  try {
    const installed = parseInstallerResponse(
      await runInstaller(
        distro,
        ['install', manifest.bundleVersion, manifest.nodeVersion, transfer.linuxPath],
        signal
      )
    )
    if (installed.kind !== 'ready') {
      throw new Error('Managed WSL watcher installation did not finish')
    }
    return { nodePath: installed.nodePath, hostPath: installed.hostPath }
  } finally {
    await Promise.all(
      transfer.transferPaths.map((transferPath) =>
        rm(transferPath, { recursive: true, force: true }).catch(() => undefined)
      )
    )
  }
}
