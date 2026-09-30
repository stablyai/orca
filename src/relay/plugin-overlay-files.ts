import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { safeRemoveOverlay } from '../main/pty/overlay-mirror'
import type { PiAgentKind } from '../shared/pi-agent-kind'

export const ORCA_MANAGED_EXTENSION_MARKER = '@orca-managed-pi-extension'

export function withOrcaManagedPiExtensionMarker(source: string): string {
  return source.includes(ORCA_MANAGED_EXTENSION_MARKER)
    ? source
    : `// ${ORCA_MANAGED_EXTENSION_MARKER}\n${source}`
}

export function safeDirName(input: string): string {
  // Why: paneKey embeds tabId:paneId where tabId may itself contain
  // filesystem-unsafe characters in some Orca builds. Hash to a fixed-width
  // hex name so any input produces a portable directory name.
  return createHash('sha256').update(input).digest('hex').slice(0, 32)
}

export function isUsableId(id: string): boolean {
  return typeof id === 'string' && id.length > 0 && id.length <= 1024
}

// Why: source-dir resolution is keyed off the launching agent (Pi or OMP).
// Both consume `PI_CODING_AGENT_DIR` but default to different `~/.<kind>/agent`
// paths on the remote disk. The renderer-chosen launch command flows in via
// the relay PtyEnvAugmenter ctx; never derived from disk presence (a
// cross-agent fallback shadows the other agent's user extensions when both
// are installed).
export const PI_AGENT_HOME_DIR_NAME: Record<PiAgentKind, string> = {
  pi: '.pi',
  omp: '.omp',
  'prime-agent': '.prime',
  omo: '.omo'
}

export function canOverwriteManagedExtension(path: string, marker: string): boolean {
  try {
    return readFileSync(path, 'utf8').includes(marker)
  } catch {
    return true
  }
}

export function writeManagedExtension(path: string, source: string, marker: string): boolean {
  if (!canOverwriteManagedExtension(path, marker)) {
    return false
  }
  writeFileSync(path, source)
  return true
}

export function writeOmoPrefillExtension(
  kind: string,
  extensionsDir: string,
  source: string | null,
  marker: string
): void {
  if (kind !== 'omo' || !source) {
    return
  }
  const prefillPath = join(extensionsDir, 'orca-prefill.ts')
  if (canOverwriteManagedExtension(prefillPath, marker)) {
    writeFileSync(prefillPath, source)
  }
}

export function clearPluginOverlayDirs(roots: readonly string[], safeName: string): void {
  for (const root of roots) {
    try {
      safeRemoveOverlay(join(root, safeName), root)
    } catch (err) {
      process.stderr.write(
        `[plugin-overlay] failed to remove overlay dir ${join(root, safeName)}: ${err instanceof Error ? err.message : String(err)}\n`
      )
    }
  }
}
