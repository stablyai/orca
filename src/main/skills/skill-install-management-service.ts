import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  SkillInstallPreview,
  SkillInstallPreviewRequest,
  SkillInstallResult,
  SkillRemoveRequest
} from '../../shared/skill-install-contract'
import {
  SkillBundleInstallPreviewSchema,
  type SkillBundleInstallPreview,
  type SkillBundleInstallPreviewRequest
} from '../../shared/skill-bundle-install-contract'
import type { SkillInstallDestinationAuthority } from './skill-install-destinations'
import { resolveSkillInstallDestination } from './skill-install-destinations'
import { inspectSkillCanonicalState } from './skill-install-planner'
import { readSkillInstallReceipt } from './skill-install-provenance'
import {
  resolveSkillProviderDestinations,
  type SkillProviderRootOverrides
} from './skill-provider-destinations'
import { removeLocalSharedSkill } from './skill-remove-transaction'
import { detectSkillProvidersInWsl } from './skill-wsl-provider-detection'
import { createWslSkillInstallFilesystem } from './skill-wsl-install-filesystem'
import { SKILL_INSTALL_PROVIDERS } from '../../shared/skill-install-providers'

type ManagementDependencies = {
  authority: SkillInstallDestinationAuthority
  stateDirectory: string
  detectProviders(): Promise<readonly string[]>
  resolveProviderRootOverrides?: (
    destination: PreviewContext['destination']
  ) => Promise<SkillProviderRootOverrides> | SkillProviderRootOverrides
}

type PreviewContext = {
  destination: Awaited<ReturnType<typeof resolveSkillInstallDestination>>
  filesystem: ReturnType<typeof createWslSkillInstallFilesystem> | undefined
  installStateDirectory: string
  detectedProviders: readonly string[]
  providerRootOverrides?: SkillProviderRootOverrides
}

const BUNDLE_PREVIEW_CONCURRENCY = 8

function canonicalPath(
  destination: Awaited<ReturnType<typeof resolveSkillInstallDestination>>,
  name: string
): string {
  return join(
    destination.scope === 'global' ? destination.homeDirectory : destination.workspaceDirectory!,
    '.agents',
    'skills',
    name
  )
}

async function preparePreviewContext(
  destinationRequest: SkillInstallPreviewRequest['destination'],
  dependencies: ManagementDependencies
): Promise<PreviewContext> {
  const destination = await resolveSkillInstallDestination(
    destinationRequest,
    dependencies.authority
  )
  const providerRootOverrides = await dependencies.resolveProviderRootOverrides?.(destination)
  return {
    destination,
    filesystem: destination.wslDistro
      ? createWslSkillInstallFilesystem({
          distro: destination.wslDistro,
          homeDirectory: destination.homeDirectory,
          workspaceDirectory: destination.workspaceDirectory,
          providerRootOverrides
        })
      : undefined,
    installStateDirectory: join(dependencies.stateDirectory, 'skill-installs'),
    detectedProviders: destination.wslDistro
      ? await detectSkillProvidersInWsl(destination.wslDistro)
      : await dependencies.detectProviders(),
    providerRootOverrides
  }
}

async function previewWithContext(
  request: SkillInstallPreviewRequest,
  context: PreviewContext
): Promise<SkillInstallPreview> {
  const path = canonicalPath(context.destination, request.name)
  const receipt = await readSkillInstallReceipt(context.installStateDirectory, path)
  const current = await inspectSkillCanonicalState({
    canonicalPath: path,
    receipt,
    manifest: {
      schemaVersion: 1,
      packageId: request.package.packageId,
      versionId: request.package.versionId,
      name: request.name,
      description: '',
      createdAt: new Date(0).toISOString(),
      files: [],
      packageDigest: request.package.packageDigest
    },
    filesystem: context.filesystem
  })
  const providers = resolveSkillProviderDestinations({
    scope: context.destination.scope,
    homeDirectory: context.destination.homeDirectory,
    workspaceDirectory: context.destination.workspaceDirectory,
    detectedProviders: context.detectedProviders,
    providerRootOverrides: context.providerRootOverrides
  })
  return {
    name: request.name,
    packageDigest: request.package.packageDigest,
    destinationIdentity: context.destination.destinationIdentity,
    currentState: current.kind,
    providers: await Promise.all(
      providers.map(async (provider) => {
        const placementPath = join(provider.rootPath, request.name)
        const stat = await lstat(placementPath).catch(() => null)
        return {
          provider: provider.provider,
          topology: provider.readsCanonicalRoot
            ? ('canonical-copy' as const)
            : ('provider-alias' as const),
          state: provider.readsCanonicalRoot || !stat ? ('ready' as const) : ('conflict' as const)
        }
      })
    )
  }
}

export async function previewSharedSkillInstall(
  request: SkillInstallPreviewRequest,
  dependencies: ManagementDependencies
): Promise<SkillInstallPreview> {
  return previewWithContext(request, await preparePreviewContext(request.destination, dependencies))
}

export async function previewSharedSkillBundleInstall(
  request: SkillBundleInstallPreviewRequest,
  dependencies: ManagementDependencies
): Promise<SkillBundleInstallPreview> {
  const context = await preparePreviewContext(request.destination, dependencies)
  const previews: SkillInstallPreview[] = []
  for (
    let offset = 0;
    offset < request.selectedSkills.length;
    offset += BUNDLE_PREVIEW_CONCURRENCY
  ) {
    const batch = request.selectedSkills.slice(offset, offset + BUNDLE_PREVIEW_CONCURRENCY)
    previews.push(
      ...(await Promise.all(
        batch.map((skill) =>
          previewWithContext(
            {
              package: {
                packageId: request.package.packageId,
                versionId: request.package.versionId,
                packageDigest: skill.digest,
                archiveSha256: request.package.archiveSha256,
                compressedBytes: request.package.compressedBytes
              },
              name: skill.name,
              destination: request.destination
            },
            context
          )
        )
      ))
    )
  }
  return SkillBundleInstallPreviewSchema.parse({
    packageId: request.package.packageId,
    versionId: request.package.versionId,
    bundleDigest: request.package.bundleDigest,
    destinationIdentity: context.destination.destinationIdentity,
    skills: request.selectedSkills.map((skill, index) => ({
      ...skill,
      currentState: previews[index].currentState
    }))
  })
}

export async function removeSharedSkillInstall(
  request: SkillRemoveRequest,
  dependencies: ManagementDependencies
): Promise<SkillInstallResult> {
  const destination = await resolveSkillInstallDestination(
    request.destination,
    dependencies.authority
  )
  const providerRootOverrides = await dependencies.resolveProviderRootOverrides?.(destination)
  const filesystem = destination.wslDistro
    ? createWslSkillInstallFilesystem({
        distro: destination.wslDistro,
        homeDirectory: destination.homeDirectory,
        workspaceDirectory: destination.workspaceDirectory,
        providerRootOverrides
      })
    : undefined
  const providerRoots = resolveSkillProviderDestinations({
    scope: destination.scope,
    homeDirectory: destination.homeDirectory,
    workspaceDirectory: destination.workspaceDirectory,
    detectedProviders: SKILL_INSTALL_PROVIDERS.map((provider) => provider.id),
    providerRootOverrides
  }).map((provider) => provider.rootPath)
  return removeLocalSharedSkill({
    operationId: request.operationId,
    canonicalPath: canonicalPath(destination, request.name),
    stateDirectory: join(dependencies.stateDirectory, 'skill-installs'),
    allowedProviderRoots: providerRoots,
    conflictResolution: request.conflictResolution,
    filesystem
  })
}
