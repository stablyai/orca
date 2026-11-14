import { lstat, readlink, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/definitive-filesystem-absence'
import { readNodeFileWithinLimit } from '../../../../shared/file-content/node-bounded-file-reader'
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
import { getProvenancePath } from '../../trust/hooks/hook-trust-promotion'
import { normalizeCodexTrustSourcePath } from '../../trust/identity/codex-trust-identity'
import { getManagedScriptPath } from '../definitions/codex-hook-definition'
import { getLegacyCodexProfileTomlPath } from '../reconciliation/codex-hook-legacy-cleanup'

export type CodexLaunchPreparationInputs = {
  digest: string
  files: ObservedFileContent[]
  paths: Map<string, string>
}

/** Unknown inputs only prevent reuse; preparation retains its existing error/retry behavior. */
export async function readCodexLaunchPreparationInputs(
  runtimeHomePath: string,
  isStillValid: () => boolean = () => true
): Promise<CodexLaunchPreparationInputs | null> {
  try {
    const systemHome = getSystemCodexHomePath()
    const homes = [...new Set([runtimeHomePath, systemHome])]
    const files: ObservedFileContent[] = []
    const paths = new Map<string, string>()
    const facts: unknown[] = []
    let systemTomlPath: string | undefined
    const recordPath = (kind: string, input: string, output: string): void => {
      paths.set(`${kind}\0${input}`, output)
      observeResolvedFilePath(kind, input, output)
    }
    for (const home of homes) {
      if (!isStillValid()) {
        return null
      }
      const resolvedHome = await resolveHome(home)
      facts.push([home, resolvedHome])
      recordPath('marketplace-home', home, resolvedHome)
      recordPath('daemon-home', home, resolvedHome)
      for (const leaf of ['config.toml', 'hooks.json']) {
        if (!isStillValid()) {
          return null
        }
        const filePath = join(home, leaf)
        const snapshot = await snapshotFile(filePath, facts)
        files.push(snapshot.observation)
        if (home === systemHome && leaf === 'config.toml') {
          systemTomlPath = snapshot.realPath ?? filePath
        }
        if (!isStillValid()) {
          return null
        }
        const writePath = snapshot.writePath
        recordPath(leaf === 'hooks.json' ? 'hooks-write' : 'toml-write', filePath, writePath)
        facts.push([`${writePath}.bak`, await entryType(`${writePath}.bak`)])
        const held = getGuardedOperationHeldPath(filePath)
        if ((await entryType(held)) !== 'absent') {
          return null
        }
        files.push({ digest: null, aliases: [held] })
        observeFileDigest(held, null)
        if (leaf === 'hooks.json') {
          recordPath(
            'trust-source',
            filePath,
            normalizeCodexTrustSourcePath(join(resolvedHome, 'hooks.json'))
          )
        }
      }
    }
    const systemToml = join(systemHome, 'config.toml')
    if (systemTomlPath === undefined) {
      return null
    }
    recordPath('promotion-write', systemToml, systemTomlPath)
    let scriptMode: number | null = null
    let legacyWritePath: string | null = null
    for (const filePath of [
      getCodexSettingsBaselinePath(runtimeHomePath),
      getProvenancePath(runtimeHomePath),
      getLegacyCodexProfileTomlPath(),
      getManagedScriptPath()
    ]) {
      if (!isStillValid()) {
        return null
      }
      const snapshot = await snapshotFile(filePath, facts)
      files.push(snapshot.observation)
      if (filePath === getManagedScriptPath()) {
        scriptMode = snapshot.mode
      }
      if (filePath === getLegacyCodexProfileTomlPath()) {
        legacyWritePath = snapshot.writePath
      }
    }
    if (!isStillValid()) {
      return null
    }
    // A mode repair is not a fixed point, even if another writer undoes chmod before the final read.
    if (scriptMode === null || legacyWritePath === null) {
      return null
    }
    if (process.platform !== 'win32' && scriptMode !== 0o755) {
      return null
    }
    facts.push(['script-mode', process.platform === 'win32' ? null : scriptMode])
    const legacyPath = getLegacyCodexProfileTomlPath()
    recordPath('toml-write', legacyPath, legacyWritePath)
    facts.push([`${legacyWritePath}.bak`, await entryType(`${legacyWritePath}.bak`)])
    facts.push([...paths], files)
    if (!isStillValid()) {
      return null
    }
    return { digest: digestFileContent(JSON.stringify(facts)), files, paths }
  } catch {
    return null
  }
}

async function resolveHome(home: string): Promise<string> {
  try {
    return await realpath(home)
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      throw error
    }
    // The production marketplace/daemon resolvers keep the spelling of an absent home.
    return home
  }
}

async function entryType(filePath: string): Promise<string> {
  try {
    const stats = await lstat(filePath)
    if (stats.isSymbolicLink()) {
      return `symlink:${await readlink(filePath)}`
    }
    return stats.isFile() ? 'file' : stats.isDirectory() ? 'directory' : 'other'
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      throw error
    }
    return 'absent'
  }
}

async function snapshotFile(
  filePath: string,
  facts: unknown[]
): Promise<{
  observation: ObservedFileContent
  realPath: string | null
  writePath: string
  mode: number | null
}> {
  const kind = await entryType(filePath)
  let realPath: string
  let digest: string | null
  let mode: number | null = null
  if (kind === 'absent') {
    // Resolve an absent leaf through its actual parent; unknown/missing ancestors decline reuse.
    realPath = join(await realpath(dirname(filePath)), basename(filePath))
    digest = null
  } else {
    const stats = await stat(filePath)
    // A shared inode lets a write at an unobserved alias affect another input.
    if (!stats.isFile() || stats.nlink !== 1) {
      throw new Error('Nonexclusive preparation input')
    }
    mode = stats.mode & 0o777
    facts.push([filePath, mode])
    realPath = await realpath(filePath)
    const opened = await readNodeFileWithinLimit(filePath, MAX_AGENT_STATE_FILE_BYTES, {
      regularFileOnly: true
    })
    if (
      opened.stats.nlink !== 1 ||
      opened.stats.dev !== stats.dev ||
      opened.stats.ino !== stats.ino ||
      opened.stats.mode !== stats.mode
    ) {
      throw new Error('Preparation input changed while opening')
    }
    digest = digestFileContent(opened.buffer)
  }
  facts.push([filePath, kind, realPath, digest])
  observeFileDigest(filePath, digest)
  return {
    observation: { digest, aliases: [...new Set([filePath, realPath])] },
    realPath: kind === 'absent' ? null : realPath,
    writePath: kind.startsWith('symlink:') ? realPath : filePath,
    mode
  }
}
