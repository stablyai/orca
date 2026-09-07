import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { z } from 'zod'
import { SKILL_INSTALL_UPDATE_REQUIRED_MESSAGE } from '../../shared/skill-install-capability'
import {
  SkillBundleInstallPreviewRequestSchema,
  SkillBundleInstallPreviewSchema
} from '../../shared/skill-bundle-install-contract'
import {
  ManagedSkillInstallListSchema,
  SkillInstallDestinationSchema,
  SkillInstallPreviewSchema,
  SkillInstallResultSchema,
  SkillPackageIdentitySchema
} from '../../shared/skill-install-contract'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import {
  supportsSkillRuntimeBundleInstall,
  supportsSkillRuntimeManagement
} from '../skills/skill-runtime-capability'
import { listWslDistrosAsync } from '../wsl'
import { callRuntimeEnvironment } from './runtime-environment-transport-routing'
import { handleMainWindowSkillIpc } from './skill-ipc-main-window'

const environmentIdSchema = z.string().min(1).max(128)
const skillNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
const installPreviewSchema = z
  .object({
    environmentId: environmentIdSchema.optional(),
    package: SkillPackageIdentitySchema,
    name: skillNameSchema,
    destination: SkillInstallDestinationSchema
  })
  .strict()
const removeSchema = z
  .object({
    environmentId: environmentIdSchema.optional(),
    name: skillNameSchema,
    destination: SkillInstallDestinationSchema,
    conflictResolution: z.enum(['replace-and-discard-local', 'cancel']).optional()
  })
  .strict()

type BundlePreviewInput = z.infer<typeof SkillBundleInstallPreviewRequestSchema> & {
  environmentId?: string
}

const REMOTE_BUNDLE_PREVIEW_CONCURRENCY = 8

async function previewBundleInstall(runtime: OrcaRuntimeService, input: BundlePreviewInput) {
  if (!input.environmentId) {
    return runtime.previewSharedSkillBundleInstallRequest(input)
  }
  const environmentId = input.environmentId
  const previews: z.infer<typeof SkillInstallPreviewSchema>[] = []
  for (
    let offset = 0;
    offset < input.selectedSkills.length;
    offset += REMOTE_BUNDLE_PREVIEW_CONCURRENCY
  ) {
    const batch = input.selectedSkills.slice(offset, offset + REMOTE_BUNDLE_PREVIEW_CONCURRENCY)
    previews.push(
      ...(await Promise.all(
        batch.map(async (skill) => {
          const request = {
            package: {
              packageId: input.package.packageId,
              versionId: input.package.versionId,
              packageDigest: skill.digest,
              archiveSha256: input.package.archiveSha256,
              compressedBytes: input.package.compressedBytes
            },
            name: skill.name,
            destination: input.destination
          }
          const response = await callRuntimeEnvironment(
            app.getPath('userData'),
            environmentId,
            'skills.previewInstall',
            request,
            30_000
          )
          if (response.ok !== true) {
            throw new Error(`skill-bundle-preview-remote-${response.error.code}`)
          }
          return SkillInstallPreviewSchema.parse(response.result)
        })
      ))
    )
  }
  return SkillBundleInstallPreviewSchema.parse({
    packageId: input.package.packageId,
    versionId: input.package.versionId,
    bundleDigest: input.package.bundleDigest,
    destinationIdentity: previews[0]?.destinationIdentity ?? '',
    skills: input.selectedSkills.map((skill, index) => ({
      ...skill,
      currentState: previews[index].currentState
    }))
  })
}

export function registerSkillInstallManagementIpcHandlers(runtime: OrcaRuntimeService): void {
  handleMainWindowSkillIpc('skills:listWslDistros', async (_event, environmentIdValue: unknown) => {
    const environmentId = environmentIdSchema.optional().parse(environmentIdValue)
    if (!environmentId) {
      return listWslDistrosAsync()
    }
    const response = await callRuntimeEnvironment(
      app.getPath('userData'),
      environmentId,
      'host.wsl.listDistros',
      {},
      15_000
    )
    return response.ok === true && Array.isArray(response.result)
      ? response.result.filter((distro): distro is string => typeof distro === 'string')
      : []
  })
  handleMainWindowSkillIpc('skills:previewInstall', async (_event, value: unknown) => {
    const input = installPreviewSchema.parse(value)
    const request = { package: input.package, name: input.name, destination: input.destination }
    if (!input.environmentId) {
      return {
        status: 'ok' as const,
        value: await runtime.previewSharedSkillInstallRequest(request)
      }
    }
    const userDataPath = app.getPath('userData')
    if (!(await supportsSkillRuntimeManagement(userDataPath, input.environmentId))) {
      return { status: 'unsupported' as const, message: SKILL_INSTALL_UPDATE_REQUIRED_MESSAGE }
    }
    const response = await callRuntimeEnvironment(
      userDataPath,
      input.environmentId,
      'skills.previewInstall',
      request,
      30_000
    )
    if (response.ok !== true) {
      throw new Error(`skill-preview-remote-${response.error.code}`)
    }
    return { status: 'ok' as const, value: SkillInstallPreviewSchema.parse(response.result) }
  })
  handleMainWindowSkillIpc('skills:previewBundleInstall', async (_event, value: unknown) => {
    const parsed = z
      .object({
        environmentId: environmentIdSchema.optional(),
        package: SkillBundleInstallPreviewRequestSchema.shape.package,
        selectedSkills: SkillBundleInstallPreviewRequestSchema.shape.selectedSkills,
        destination: SkillInstallDestinationSchema
      })
      .strict()
      .parse(value)
    if (
      parsed.environmentId &&
      (!(await supportsSkillRuntimeManagement(app.getPath('userData'), parsed.environmentId)) ||
        !(await supportsSkillRuntimeBundleInstall(app.getPath('userData'), parsed.environmentId)))
    ) {
      return { status: 'unsupported' as const, message: SKILL_INSTALL_UPDATE_REQUIRED_MESSAGE }
    }
    return { status: 'ok' as const, value: await previewBundleInstall(runtime, parsed) }
  })
  handleMainWindowSkillIpc('skills:removeInstall', async (_event, value: unknown) => {
    const input = removeSchema.parse(value)
    const request = {
      operationId: randomUUID(),
      name: input.name,
      destination: input.destination,
      conflictResolution: input.conflictResolution
    }
    if (!input.environmentId) {
      return {
        status: 'ok' as const,
        value: await runtime.removeSharedSkillInstallRequest(request)
      }
    }
    const userDataPath = app.getPath('userData')
    if (!(await supportsSkillRuntimeManagement(userDataPath, input.environmentId))) {
      return { status: 'unsupported' as const, message: SKILL_INSTALL_UPDATE_REQUIRED_MESSAGE }
    }
    const response = await callRuntimeEnvironment(
      userDataPath,
      input.environmentId,
      'skills.removeInstall',
      request,
      5 * 60_000
    )
    if (response.ok !== true) {
      throw new Error(`skill-remove-remote-${response.error.code}`)
    }
    return { status: 'ok' as const, value: SkillInstallResultSchema.parse(response.result) }
  })
  handleMainWindowSkillIpc(
    'skills:listManagedInstalls',
    async (_event, environmentIdValue: unknown) => {
      const environmentId = environmentIdSchema.optional().parse(environmentIdValue)
      if (!environmentId) {
        return { status: 'ok' as const, value: await runtime.listManagedSkillInstalls() }
      }
      if (environmentId.startsWith('ssh:')) {
        const value = await runtime.listManagedSkillInstalls(environmentId.slice('ssh:'.length))
        return { status: 'ok' as const, value }
      }
      const userDataPath = app.getPath('userData')
      if (!(await supportsSkillRuntimeManagement(userDataPath, environmentId))) {
        return { status: 'unsupported' as const, message: SKILL_INSTALL_UPDATE_REQUIRED_MESSAGE }
      }
      const response = await callRuntimeEnvironment(
        userDataPath,
        environmentId,
        'skills.listManagedInstalls',
        {},
        30_000
      )
      if (response.ok !== true) {
        throw new Error(`skill-list-managed-remote-${response.error.code}`)
      }
      return { status: 'ok' as const, value: ManagedSkillInstallListSchema.parse(response.result) }
    }
  )
}
