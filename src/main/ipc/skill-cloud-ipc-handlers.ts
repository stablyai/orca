import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { z } from 'zod'
import { SKILL_INSTALL_UPDATE_REQUIRED_MESSAGE } from '../../shared/skill-install-capability'
import type { SkillDiscoveryResult, SkillDiscoveryTargetSchema } from '../../shared/skills'
import type { SkillCloudDownloadGrant } from '../../shared/skill-cloud-contract'
import type { SkillBundleInstallProgress } from '../../shared/skill-bundle-install-contract'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import {
  installSkillBundleCloudGrant,
  installSkillCloudGrant
} from '../skills/skill-cloud-grant-installation'
import { SkillRemoteInstallCancellation } from '../skills/skill-remote-install-cancellation'
import { classifySkillCloudInstallTarget } from '../skills/skill-cloud-install-target'
import { assertSkillCloudGrantVersion } from '../skills/skill-cloud-grant-version'
import { SkillSharePreparationService } from '../skills/skill-share-preparation-service'
import {
  supportsSkillRuntimeBundleInstall,
  supportsSkillRuntimeCancellation,
  supportsSkillRuntimeInstall
} from '../skills/skill-runtime-capability'
import { callRuntimeEnvironment } from './runtime-environment-transport-routing'
import { registerSkillInstallManagementIpcHandlers } from './skill-install-management-ipc-handlers'
import { handleMainWindowSkillIpc } from './skill-ipc-main-window'
import { sendBundleInstallProgress, sendSkillInstallProgress } from './skill-install-progress-ipc'
import {
  skillCloudBundlePackageVersionInstallSchema,
  skillCloudBundleShareInstallSchema,
  skillCloudInstallEnvironmentIdSchema,
  skillCloudPackageVersionInstallSchema,
  skillCloudShareInstallSchema
} from './skill-cloud-install-ipc-schemas'
import {
  skillSharePrepareIpcSchema,
  skillSharePublishIpcSchema
} from './skill-share-publishing-ipc-schemas'

const packageVersionSchema = z
  .object({
    packageId: z.string().min(1).max(128),
    versionId: z.string().min(1).max(128)
  })
  .strict()

function registerSharingHandlers(
  runtime: OrcaRuntimeService,
  discover: (target?: z.infer<typeof SkillDiscoveryTargetSchema>) => Promise<SkillDiscoveryResult>
): void {
  const preparations = new SkillSharePreparationService(
    join(app.getPath('userData'), 'skill-share-preparations'),
    {
      publishVersion: (request) => runtime.publishSkillPackageVersion(request),
      createShare: (packageId, request) => runtime.createSkillPackageShare(packageId, request)
    },
    { installStateDirectory: join(app.getPath('userData'), 'skill-installs') }
  )
  handleMainWindowSkillIpc('skills:prepareShare', async (_event, value: unknown) => {
    const input = skillSharePrepareIpcSchema.parse(value)
    const result = await discover(input.target)
    const requested = new Set(input.skillIds)
    const skills = result.skills.filter((candidate) => requested.has(candidate.id))
    if (skills.length !== requested.size) {
      throw new Error('skill-share-source-not-found')
    }
    return preparations.prepare({
      sources: skills.map((skill) => ({ id: skill.name, sourceDirectory: skill.directoryPath })),
      bundleName: input.bundleName,
      description:
        skills.length === 1 ? (skills[0].description ?? '') : `${skills.length} shared skills`,
      packageId: input.packageId
    })
  })
  handleMainWindowSkillIpc('skills:publishShare', async (_event, value: unknown) => {
    const input = skillSharePublishIpcSchema.parse(value)
    return preparations.publish(input, (progress) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send('skills:shareProgress', progress)
        }
      }
    })
  })
  handleMainWindowSkillIpc('skills:cancelShare', (_event, id: unknown) => {
    preparations.cancel(z.string().uuid().parse(id))
  })
  handleMainWindowSkillIpc('skills:releaseShare', async (_event, id: unknown) => {
    await preparations.release(z.string().uuid().parse(id))
  })
}

function registerCloudInstallHandlers(runtime: OrcaRuntimeService): void {
  const remoteInstallCancellation = new SkillRemoteInstallCancellation()
  const installAuthorizedGrant = async (
    grant: SkillCloudDownloadGrant,
    input:
      | z.infer<typeof skillCloudShareInstallSchema>
      | z.infer<typeof skillCloudPackageVersionInstallSchema>
  ) => {
    if (!input.environmentId || input.environmentId.startsWith('ssh:')) {
      return installSkillCloudGrant(runtime, grant, {
        ...input,
        operationId: input.operationId ?? randomUUID()
      })
    }
    const operationId = input.operationId ?? randomUUID()
    const signal = remoteInstallCancellation.begin(operationId)
    try {
      return await installSkillCloudGrant(runtime, grant, { ...input, operationId }, signal)
    } finally {
      remoteInstallCancellation.finish(operationId, signal)
    }
  }
  const installAuthorizedBundleGrant = async (
    grant: SkillCloudDownloadGrant,
    input:
      | z.infer<typeof skillCloudBundleShareInstallSchema>
      | z.infer<typeof skillCloudBundlePackageVersionInstallSchema>,
    onProgress: (progress: SkillBundleInstallProgress) => void
  ) => {
    if (!input.environmentId || input.environmentId.startsWith('ssh:')) {
      return installSkillBundleCloudGrant(
        runtime,
        grant,
        {
          ...input,
          operationId: input.operationId ?? randomUUID()
        },
        undefined,
        onProgress
      )
    }
    const operationId = input.operationId ?? randomUUID()
    const signal = remoteInstallCancellation.begin(operationId)
    try {
      return await installSkillBundleCloudGrant(
        runtime,
        grant,
        { ...input, operationId },
        signal,
        onProgress
      )
    } finally {
      remoteInstallCancellation.finish(operationId, signal)
    }
  }
  handleMainWindowSkillIpc('skills:resolveShare', (_event, shareId: unknown) =>
    runtime.resolveSkillShare(z.string().min(1).max(128).parse(shareId), {})
  )
  handleMainWindowSkillIpc('skills:installShare', async (event, value: unknown) => {
    const parsed = skillCloudShareInstallSchema.parse(value)
    const input = { ...parsed, operationId: parsed.operationId ?? randomUUID() }
    sendSkillInstallProgress(event, { operationId: input.operationId, phase: 'authorizing' })
    if (
      input.environmentId &&
      !(await supportsSkillRuntimeInstall(app.getPath('userData'), input.environmentId))
    ) {
      return { status: 'unsupported' as const, message: SKILL_INSTALL_UPDATE_REQUIRED_MESSAGE }
    }
    const installTarget = await classifySkillCloudInstallTarget(runtime, input)
    const grant = await runtime.createSkillDownloadGrant(input.shareId, {
      versionId: input.versionId,
      installTarget
    })
    if (grant.status === 'ok') {
      assertSkillCloudGrantVersion(grant.value, input.versionId)
      sendSkillInstallProgress(event, { operationId: input.operationId, phase: 'installing' })
    }
    return grant.status === 'ok' ? installAuthorizedGrant(grant.value, input) : grant
  })
  handleMainWindowSkillIpc('skills:installBundleShare', async (event, value: unknown) => {
    const parsed = skillCloudBundleShareInstallSchema.parse(value)
    const input = { ...parsed, operationId: parsed.operationId ?? randomUUID() }
    sendSkillInstallProgress(event, { operationId: input.operationId, phase: 'authorizing' })
    if (
      input.environmentId &&
      !input.environmentId.startsWith('ssh:') &&
      !(await supportsSkillRuntimeBundleInstall(app.getPath('userData'), input.environmentId))
    ) {
      return { status: 'unsupported' as const, message: SKILL_INSTALL_UPDATE_REQUIRED_MESSAGE }
    }
    const installTarget = await classifySkillCloudInstallTarget(runtime, input)
    const grant = await runtime.createSkillDownloadGrant(input.shareId, {
      versionId: input.versionId,
      installTarget
    })
    if (grant.status === 'ok') {
      assertSkillCloudGrantVersion(grant.value, input.versionId)
      sendSkillInstallProgress(event, { operationId: input.operationId, phase: 'installing' })
    }
    return grant.status === 'ok'
      ? installAuthorizedBundleGrant(grant.value, input, (progress) =>
          sendBundleInstallProgress(event, progress)
        )
      : grant
  })
  handleMainWindowSkillIpc('skills:installPackageVersion', async (event, value: unknown) => {
    const parsed = skillCloudPackageVersionInstallSchema.parse(value)
    const input = { ...parsed, operationId: parsed.operationId ?? randomUUID() }
    sendSkillInstallProgress(event, { operationId: input.operationId, phase: 'authorizing' })
    if (
      input.environmentId &&
      !(await supportsSkillRuntimeInstall(app.getPath('userData'), input.environmentId))
    ) {
      return { status: 'unsupported' as const, message: SKILL_INSTALL_UPDATE_REQUIRED_MESSAGE }
    }
    const installTarget = await classifySkillCloudInstallTarget(runtime, input)
    const grant = await runtime.createSkillPackageVersionDownloadGrant(
      input.packageId,
      input.versionId,
      { installTarget }
    )
    if (grant.status === 'ok') {
      assertSkillCloudGrantVersion(grant.value, input.versionId)
      sendSkillInstallProgress(event, { operationId: input.operationId, phase: 'installing' })
    }
    return grant.status === 'ok' ? installAuthorizedGrant(grant.value, input) : grant
  })
  handleMainWindowSkillIpc('skills:installBundlePackageVersion', async (event, value: unknown) => {
    const parsed = skillCloudBundlePackageVersionInstallSchema.parse(value)
    const input = { ...parsed, operationId: parsed.operationId ?? randomUUID() }
    sendSkillInstallProgress(event, { operationId: input.operationId, phase: 'authorizing' })
    if (
      input.environmentId &&
      !input.environmentId.startsWith('ssh:') &&
      !(await supportsSkillRuntimeBundleInstall(app.getPath('userData'), input.environmentId))
    ) {
      return { status: 'unsupported' as const, message: SKILL_INSTALL_UPDATE_REQUIRED_MESSAGE }
    }
    const installTarget = await classifySkillCloudInstallTarget(runtime, input)
    const grant = await runtime.createSkillPackageVersionDownloadGrant(
      input.packageId,
      input.versionId,
      { installTarget }
    )
    if (grant.status === 'ok') {
      assertSkillCloudGrantVersion(grant.value, input.versionId)
      sendSkillInstallProgress(event, { operationId: input.operationId, phase: 'installing' })
    }
    return grant.status === 'ok'
      ? installAuthorizedBundleGrant(grant.value, input, (progress) =>
          sendBundleInstallProgress(event, progress)
        )
      : grant
  })
  handleMainWindowSkillIpc('skills:cancelInstall', async (_event, value: unknown) => {
    const input = z
      .object({
        operationId: z.string().min(1).max(128),
        environmentId: skillCloudInstallEnvironmentIdSchema.optional()
      })
      .strict()
      .parse(value)
    if (!input.environmentId || input.environmentId.startsWith('ssh:')) {
      return { cancelled: runtime.cancelSharedSkillInstall(input.operationId) }
    }
    const transferCancelled = remoteInstallCancellation.cancel(input.operationId)
    if (!(await supportsSkillRuntimeCancellation(app.getPath('userData'), input.environmentId))) {
      return { cancelled: transferCancelled }
    }
    const response = await callRuntimeEnvironment(
      app.getPath('userData'),
      input.environmentId,
      'skills.cancelInstall',
      { operationId: input.operationId },
      15_000
    ).catch(() => null)
    const installCancelled =
      response?.ok === true && response.result && typeof response.result === 'object'
        ? (response.result as { cancelled?: unknown }).cancelled === true
        : false
    return { cancelled: transferCancelled || installCancelled }
  })
  handleMainWindowSkillIpc('skills:getPackage', (_event, packageId: unknown) =>
    runtime.getSkillPackage(z.string().min(1).max(128).parse(packageId), {})
  )
  handleMainWindowSkillIpc('skills:listOwnedShares', () => runtime.listOwnedSkillShares({}))
  handleMainWindowSkillIpc('skills:revokeShare', (_event, shareId: unknown) =>
    runtime.revokeSkillShare(z.string().min(1).max(128).parse(shareId), {})
  )
  handleMainWindowSkillIpc('skills:deletePackageVersion', (_event, value: unknown) => {
    const input = packageVersionSchema.parse(value)
    return runtime.deleteSkillPackageVersion(input.packageId, input.versionId, {})
  })
  handleMainWindowSkillIpc('skills:deletePackage', (_event, packageId: unknown) =>
    runtime.deleteSkillPackage(z.string().min(1).max(128).parse(packageId), {})
  )
}

export function registerSkillCloudIpcHandlers(
  runtime: OrcaRuntimeService,
  discover: (target?: z.infer<typeof SkillDiscoveryTargetSchema>) => Promise<SkillDiscoveryResult>
): void {
  registerSharingHandlers(runtime, discover)
  registerCloudInstallHandlers(runtime)
  registerSkillInstallManagementIpcHandlers(runtime)
}
