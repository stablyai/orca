import { execFileSync } from 'node:child_process'
import { app } from 'electron'

/**
 * True when this is the x64 build running under Rosetta 2 on Apple Silicon.
 *
 * Why: users routinely download the Intel `.dmg` onto an Apple Silicon Mac and
 * hit severe, unexplained lag — the entire app is binary-translated. We surface
 * this so the renderer can nudge them to the native arm64 build. Non-macOS
 * platforms have no Rosetta, so this is always false off darwin.
 */
export function isRunningTranslatedOnAppleSilicon(): boolean {
  if (process.platform !== 'darwin') {
    return false
  }

  // Electron exposes the translation flag synchronously; prefer it when present.
  const translated = (app as { runningUnderARM64Translation?: boolean })
    .runningUnderARM64Translation
  if (typeof translated === 'boolean') {
    return translated
  }

  // Fallback: Apple's documented sysctl flag (1 = process is translated). `-i`
  // ignores the OID on Intel Macs where it doesn't exist; a failure just skips
  // the nudge rather than blocking startup.
  try {
    const out = execFileSync('sysctl', ['-in', 'sysctl.proc_translated'], {
      encoding: 'utf8'
    })
    return out.trim() === '1'
  } catch {
    return false
  }
}
