import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import process from 'node:process'

// PackageJsonAndroidAndIosScriptsIfNotContainRun | PackageJsonScriptsAll: npm scripts never reach
// prebuild or gradle, and what postinstall generates is already inside the shell JS hash.
const SOURCE_SKIPS = String(512 | 1024)

/** One fingerprint source reduced to what identifies it; `hash` is null when git ignores it. */
export function nativeSourceEntry(source) {
  return {
    type: source.type,
    id: source.filePath ?? source.id,
    hash: source.hash ?? null
  }
}

/**
 * Our own digest, not @expo/fingerprint's: ignored sources (a local prebuild `android/`) are
 * listed with a null hash, and must not make a developer tree differ from a clean CI checkout.
 */
export function nativeSourcesDigest(entries) {
  const lines = entries
    .filter((entry) => entry.hash !== null)
    .map((entry) => `${entry.type}\t${entry.id}\t${entry.hash}`)
    .sort()
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}

export function computeNativeFingerprint(projectDir, platform) {
  const cli = path.join(projectDir, 'node_modules', 'expo', 'bin', 'fingerprint')
  const stdout = execFileSync(
    process.execPath,
    [cli, 'fingerprint:generate', '--platform', platform, '--source-skips', SOURCE_SKIPS],
    { cwd: projectDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 2] }
  )
  const sources = JSON.parse(stdout)
    .sources.map(nativeSourceEntry)
    .filter((entry) => entry.hash !== null)
  return { hash: nativeSourcesDigest(sources), sources }
}
