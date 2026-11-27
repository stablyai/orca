import { z } from 'zod'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import { SkillBundleInstallRequestSchema } from '../../../shared/skills/installation/skill-bundle-install-contract'
import { SkillInstallDestinationSchema } from '../../../shared/skills/installation/skill-install-contract'

export const skillCloudInstallEnvironmentIdSchema = lazyZodSchema(() => z.string().min(1).max(128))

const skillCloudInstallProvidersSchema = lazyZodSchema(() =>
  z.array(z.string().min(1).max(64)).max(64)
)

const createInstallDestinationFields = () => ({
  operationId: z.string().min(1).max(128).optional(),
  environmentId: skillCloudInstallEnvironmentIdSchema.optional(),
  destination: SkillInstallDestinationSchema,
  providers: skillCloudInstallProvidersSchema.optional(),
  conflictResolution: z
    .enum(['replace-unmodified', 'replace-and-discard-local', 'cancel'])
    .optional()
})

export const skillCloudShareInstallSchema = lazyZodSchema(() =>
  z
    .object({
      shareId: z.string().min(1).max(128),
      versionId: z.string().min(1).max(128),
      ...createInstallDestinationFields()
    })
    .strict()
)

export const skillCloudBundleShareInstallSchema = lazyZodSchema(() =>
  z
    .object({
      shareId: z.string().min(1).max(128),
      versionId: z.string().min(1).max(128),
      operationId: z.string().min(1).max(128).optional(),
      environmentId: skillCloudInstallEnvironmentIdSchema.optional(),
      selectedSkillIds: SkillBundleInstallRequestSchema.shape.selectedSkillIds,
      destination: SkillInstallDestinationSchema,
      providers: skillCloudInstallProvidersSchema.optional(),
      conflictDecisions: SkillBundleInstallRequestSchema.shape.conflictDecisions.optional()
    })
    .strict()
)

export const skillCloudPackageVersionInstallSchema = lazyZodSchema(() =>
  z
    .object({
      packageId: z.string().min(1).max(128),
      versionId: z.string().min(1).max(128),
      ...createInstallDestinationFields()
    })
    .strict()
)

export const skillCloudBundlePackageVersionInstallSchema = lazyZodSchema(() =>
  z
    .object({
      packageId: z.string().min(1).max(128),
      versionId: z.string().min(1).max(128),
      operationId: z.string().min(1).max(128).optional(),
      environmentId: skillCloudInstallEnvironmentIdSchema.optional(),
      selectedSkillIds: SkillBundleInstallRequestSchema.shape.selectedSkillIds,
      destination: SkillInstallDestinationSchema,
      providers: skillCloudInstallProvidersSchema.optional(),
      conflictDecisions: SkillBundleInstallRequestSchema.shape.conflictDecisions.optional()
    })
    .strict()
)
