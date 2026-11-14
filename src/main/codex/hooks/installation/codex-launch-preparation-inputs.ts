import { lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/definitive-filesystem-absence'
import { readNodeFileSyncWithinLimit } from '../../../../shared/file-content/node-bounded-file-reader'
import { resolveHooksJsonWritePath } from '../../../agent-hooks/installation/configuration/hook-config-write-path'
import { getGuardedOperationHeldPath } from '../../../filesystem/atomic-file-publication'
import {
  digestFileContent,
  observeFileDigest,
  observeResolvedFilePath,
  type ObservedFileContent
} from '../../../filesystem/file-content-observation'
import { MAX_AGENT_STATE_FILE_BYTES } from '../../configuration/agent-state-file-reader'
import { getSystemCodexHomePath } from '../../configuration/homes/codex-home-paths'
import { getCodexSettingsBaselinePath } from '../../configuration/settings/config-settings-baseline'
import { resolvePromotionWriteTarget } from '../../configuration/settings/config-settings-promotion-write-target'
import { resolveTomlWritePath } from '../../configuration/toml/config-toml-atomic-write'
import { getProvenancePath } from '../../trust/hooks/hook-trust-promotion'
import { getExplicitHomeCodexHookSourcePath } from '../../trust/identity/codex-trust-identity'
import { getManagedScriptPath } from '../definitions/codex-hook-definition'
import { getLegacyCodexProfileTomlPath } from '../reconciliation/codex-hook-legacy-cleanup'

export type CodexLaunchPreparationInputs = {
  digest: string
  files: ObservedFileContent[]
  paths: Map<string, string>
}

/** Unknown inputs only prevent reuse; preparation retains its existing error/retry behavior. */
export function readCodexLaunchPreparationInputs(
  runtimeHomePath: string,
  isStillValid: () => boolean = () => true
): CodexLaunchPreparationInputs | null {
  try {
    const systemHome = getSystemCodexHomePath()
    const homes = [...new Set([runtimeHomePath, systemHome])]
    const files: ObservedFileContent[] = []
    const paths = new Map<string, string>()
    const facts: unknown[] = []
    const recordPath = (kind: string, input: string, output: string): void => {
      paths.set(`${kind}\0${input}`, output)
      observeResolvedFilePath(kind, input, output)
    }
    for (const home of homes) {
      if (!isStillValid()) {
        return null
      }
      const resolvedHome = resolveHome(home)
      facts.push([home, resolvedHome])
      recordPath('marketplace-home', home, resolvedHome)
      recordPath('daemon-home', home, resolvedHome)
      for (const leaf of ['config.toml', 'hooks.json']) {
        if (!isStillValid()) {
          return null
        }
        const filePath = join(home, leaf)
        files.push(snapshotFile(filePath, facts))
        if (!isStillValid()) {
          return null
        }
        const writePath =
          leaf === 'hooks.json'
            ? resolveHooksJsonWritePath(filePath)
            : resolveTomlWritePath(filePath)
        recordPath(leaf === 'hooks.json' ? 'hooks-write' : 'toml-write', filePath, writePath)
        facts.push([`${writePath}.bak`, entryType(`${writePath}.bak`)])
        const held = getGuardedOperationHeldPath(filePath)
        if (entryType(held) !== 'absent') {
          return null
        }
        files.push({ digest: null, aliases: [held] })
        observeFileDigest(held, null)
        if (leaf === 'hooks.json') {
          recordPath('trust-source', filePath, getExplicitHomeCodexHookSourcePath(filePath))
        }
      }
    }
    const systemToml = join(systemHome, 'config.toml')
    recordPath('promotion-write', systemToml, resolvePromotionWriteTarget(systemToml).path)
    for (const filePath of [
      getCodexSettingsBaselinePath(runtimeHomePath),
      getProvenancePath(runtimeHomePath),
      getLegacyCodexProfileTomlPath(),
      getManagedScriptPath()
    ]) {
      if (!isStillValid()) {
        return null
      }
      files.push(snapshotFile(filePath, facts))
    }
    if (!isStillValid()) {
      return null
    }
    const scriptPath = getManagedScriptPath()
    // A mode repair is not a fixed point, even if another writer undoes chmod before the final read.
    const scriptMode = statSync(scriptPath).mode & 0o777
    if (process.platform !== 'win32' && scriptMode !== 0o755) {
      return null
    }
    facts.push(['script-mode', process.platform === 'win32' ? null : scriptMode])
    const legacyPath = getLegacyCodexProfileTomlPath()
    const legacyWritePath = resolveTomlWritePath(legacyPath)
    recordPath('toml-write', legacyPath, legacyWritePath)
    facts.push([`${legacyWritePath}.bak`, entryType(`${legacyWritePath}.bak`)])
    facts.push([...paths], files)
    if (!isStillValid()) {
      return null
    }
    return { digest: digestFileContent(JSON.stringify(facts)), files, paths }
  } catch {
    return null
  }
}

function resolveHome(home: string): string {
  try {
    return realpathSync.native(home)
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      throw error
    }
    // The production marketplace/daemon resolvers keep the spelling of an absent home.
    return home
  }
}

function entryType(filePath: string): string {
  try {
    const stat = lstatSync(filePath)
    if (stat.isSymbolicLink()) {
      return `symlink:${readlinkSync(filePath)}`
    }
    return stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other'
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      throw error
    }
    return 'absent'
  }
}

function snapshotFile(filePath: string, facts: unknown[]): ObservedFileContent {
  const kind = entryType(filePath)
  let realPath: string
  let digest: string | null
  if (kind === 'absent') {
    // Resolve an absent leaf through its actual parent; unknown/missing ancestors decline reuse.
    realPath = join(realpathSync.native(dirname(filePath)), basename(filePath))
    digest = null
  } else {
    const stat = statSync(filePath)
    // A shared inode lets a write at an unobserved alias affect another input.
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error('Nonexclusive preparation input')
    }
    facts.push([filePath, stat.mode & 0o777])
    realPath = realpathSync.native(filePath)
    const { buffer, stats } = readNodeFileSyncWithinLimit(filePath, MAX_AGENT_STATE_FILE_BYTES, {
      regularFileOnly: true
    })
    if (
      stats.nlink !== 1 ||
      stats.dev !== stat.dev ||
      stats.ino !== stat.ino ||
      stats.mode !== stat.mode
    ) {
      throw new Error('Preparation input changed while opening')
    }
    digest = digestFileContent(buffer)
  }
  facts.push([filePath, kind, realPath, digest])
  observeFileDigest(filePath, digest)
  return { digest, aliases: [...new Set([filePath, realPath])] }
}
