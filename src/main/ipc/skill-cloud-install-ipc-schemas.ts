import { z } from 'zod'
import { SkillBundleInstallRequestSchema } from '../../shared/skill-bundle-install-contract'
import { SkillInstallDestinationSchema } from '../../shared/skill-install-contract'

export const skillCloudInstallEnvironmentIdSchema = z.string().min(1).max(128)

const skillCloudInstallProvidersSchema = z.array(z.string().min(1).max(64)).max(64)

const installDestinationFields = {
  operationId: z.string().min(1).max(128).optional(),
  environmentId: skillCloudInstallEnvironmentIdSchema.optional(),
  destination: SkillInstallDestinationSchema,
  providers: skillCloudInstallProvidersSchema.optional(),
  conflictResolution: z
    .enum(['replace-unmodified', 'replace-and-discard-local', 'cancel'])
    .optional()
} as const

export const skillCloudShareInstallSchema = z
  .object({
    shareId: z.string().min(1).max(128),
    versionId: z.string().min(1).max(128),
    ...installDestinationFields
  })
  .strict()

export const skillCloudBundleShareInstallSchema = z
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

export const skillCloudPackageVersionInstallSchema = z
  .object({
    packageId: z.string().min(1).max(128),
    versionId: z.string().min(1).max(128),
    ...installDestinationFields
  })
  .strict()

export const skillCloudBundlePackageVersionInstallSchema = z
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
