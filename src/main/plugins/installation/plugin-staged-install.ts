import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginManifestWithPublisher } from '../../../shared/plugins/manifest/plugin-manifest'
import type { PluginVmRecipeIdentities } from '../../../shared/plugins/approval/plugin-update-access-growth'
import {
  gitUrlPluginPublisher,
  localPluginPublisher
} from '../../../shared/plugins/installation/plugin-publisher-derivation'
import { isSameGitRepository } from '../../../shared/plugins/catalog/plugin-marketplace'
import { readPluginVmRecipeIdentities } from '../plugin-vm-recipe-identities'
import { checkoutPluginGitSource } from './plugin-git-repository'
import {
  declaredPublisher,
  installedPublisherFor,
  installPluginFromLocalPath,
  type PluginInstallResult
} from './plugin-install'
import { inspectPluginInstallTree, installStagedPluginTree } from './plugin-install-staging'
import { serializePluginMutation } from './plugin-mutation-queue'

/** Bytes downloaded and verified but not installed yet, so approval can be decided first. */
export type StagedPluginInstall = {
  pluginKey: string
  manifest: PluginManifestWithPublisher
  contentHash: string
  consentFingerprint: string
  resolvedCommit: string | null
  vmRecipeIdentities: PluginVmRecipeIdentities
  /** Publishes exactly the staged bytes. */
  install: () => Promise<PluginInstallResult>
  dispose: () => Promise<void>
}

async function inspectStaged(input: {
  rootDir: string
  hostVersion: string
  publisher: string
}): Promise<Omit<StagedPluginInstall, 'resolvedCommit' | 'install' | 'dispose'>> {
  const inspection = await inspectPluginInstallTree({
    rootDir: input.rootDir,
    hostVersion: input.hostVersion,
    identity: { publisher: input.publisher }
  })
  if (!inspection.ok) {
    throw new Error(inspection.error)
  }
  return {
    pluginKey: inspection.pluginKey,
    manifest: inspection.manifest,
    contentHash: inspection.contentHash,
    consentFingerprint: inspection.consentFingerprint,
    vmRecipeIdentities: await readPluginVmRecipeIdentities(input.rootDir, inspection.manifest)
  }
}

/** Downloads one exact commit once; install publishes that same tree like `installPluginFromGit`. */
export async function stagePluginGitInstall(input: {
  pluginsDir: string
  url: string
  ref: string
  commit: string
  hostVersion: string
  blockedPluginReason?: (pluginKey: string) => string | null
}): Promise<StagedPluginInstall> {
  const stagingDir = await mkdtemp(join(tmpdir(), 'orca-plugin-cli-install-'))
  const dispose = (): Promise<void> => rm(stagingDir, { recursive: true, force: true })
  try {
    const resolvedCommit = await checkoutPluginGitSource({
      url: input.url,
      ref: input.commit,
      destination: stagingDir,
      workingDirectory: tmpdir()
    })
    // Why the same order as installPluginFromGit: a reinstall keeps the key its data is stored under.
    const publisher =
      (await installedPublisherFor(
        input.pluginsDir,
        (source) => source.kind === 'git' && isSameGitRepository(source.url, input.url)
      )) ??
      gitUrlPluginPublisher(input.url) ??
      (await declaredPublisher(stagingDir))
    if (!publisher) {
      throw new Error(
        'cannot name a publisher for this Git URL; use one with an owner (host/owner/repo)'
      )
    }
    const staged = await inspectStaged({
      rootDir: stagingDir,
      hostVersion: input.hostVersion,
      publisher
    })
    return {
      ...staged,
      resolvedCommit,
      install: () =>
        serializePluginMutation(input.pluginsDir, () =>
          installStagedPluginTree({
            pluginsDir: input.pluginsDir,
            stagingDir,
            hostVersion: input.hostVersion,
            source: { kind: 'git', url: input.url, ref: input.ref },
            resolvedCommit,
            identity: { publisher },
            blockedPluginReason: input.blockedPluginReason
          })
        ),
      dispose
    }
  } catch (error) {
    await dispose()
    throw error
  }
}

/** Inspects a folder in place; install copies it and fails if it changed since. */
export async function stagePluginLocalInstall(input: {
  pluginsDir: string
  path: string
  hostVersion: string
  blockedPluginReason?: (pluginKey: string) => string | null
}): Promise<StagedPluginInstall> {
  const publisher =
    (await installedPublisherFor(
      input.pluginsDir,
      (source) => source.kind === 'local-path' && source.path === input.path
    )) ?? localPluginPublisher(await declaredPublisher(input.path))
  const staged = await inspectStaged({
    rootDir: input.path,
    hostVersion: input.hostVersion,
    publisher
  })
  return {
    ...staged,
    resolvedCommit: null,
    install: async () => {
      const result = await installPluginFromLocalPath({
        pluginsDir: input.pluginsDir,
        sourcePath: input.path,
        hostVersion: input.hostVersion,
        blockedPluginReason: input.blockedPluginReason
      })
      return result.ok && result.contentHash !== staged.contentHash
        ? { ok: false, error: 'the plugin folder changed while it was being installed; run again' }
        : result
    },
    dispose: async () => undefined
  }
}
