import { z } from 'zod'

export const AdmissionStateSchema = z.enum([
  'existing-only',
  'migration-only',
  'general'
])

export type AdmissionState = z.infer<typeof AdmissionStateSchema>

export const SelectorMembershipSchema = z.object({
  existingOnly: z.array(z.string()),
  migrationOnly: z.array(z.string()),
  general: z.array(z.string())
})

export type SelectorMembership = z.infer<typeof SelectorMembershipSchema>

export const AdmissionSelectorSchema = z.object({
  generation: z.number().int().nonnegative(),
  membership: SelectorMembershipSchema
})

export type AdmissionSelector = z.infer<typeof AdmissionSelectorSchema>

export function normalizeSelectorMembership(
  membership: SelectorMembership,
  configuredCellIds: ReadonlySet<string>
): SelectorMembership {
  const normalized = {
    existingOnly: [...membership.existingOnly].sort(),
    migrationOnly: [...membership.migrationOnly].sort(),
    general: [...membership.general].sort()
  }
  const all = [
    ...normalized.existingOnly,
    ...normalized.migrationOnly,
    ...normalized.general
  ]
  if (
    all.length !== configuredCellIds.size ||
    new Set(all).size !== all.length ||
    all.some((cellId) => !configuredCellIds.has(cellId))
  ) {
    throw new Error('selector membership must contain every configured cell exactly once')
  }
  return normalized
}

export function selectorCellState(
  selector: AdmissionSelector,
  cellId: string
): AdmissionState {
  if (selector.membership.existingOnly.includes(cellId)) return 'existing-only'
  if (selector.membership.migrationOnly.includes(cellId)) return 'migration-only'
  if (selector.membership.general.includes(cellId)) return 'general'
  throw new Error(`selector does not contain ${cellId}`)
}

export function effectiveAdmissionState(
  selector: AdmissionSelector,
  legacyEnabled: boolean,
  cellId: string
): AdmissionState {
  if (selector.generation === 0) return legacyEnabled ? 'general' : 'existing-only'
  return selectorCellState(selector, cellId)
}

export function exactAdmissionSelector(
  actual: AdmissionSelector,
  expected: AdmissionSelector
): boolean {
  return (
    actual.generation === expected.generation &&
    JSON.stringify(actual.membership) === JSON.stringify(expected.membership)
  )
}
