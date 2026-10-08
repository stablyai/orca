import type { PersistedUIState } from '../../../../shared/persisted-ui-state-types'
import {
  BUNDLED_PET_IDS,
  DEFAULT_PET_ID,
  isBundledPetId,
  type CustomPet,
  type PetLibrary
} from '../../../../shared/pet-types'
import { InvalidArgumentError } from '../core'

/** Mirrors renderer hydration: pre-rename builds stored `customSidekicks`, which new `customPets` writes replace. */
export function readCustomPets(ui: PersistedUIState): CustomPet[] {
  if (Array.isArray(ui.customPets)) {
    return ui.customPets
  }
  return Array.isArray(ui.customSidekicks) ? ui.customSidekicks : []
}

/** Mirrors renderer hydration: an unknown id renders the default pet, so report that one as active. */
export function readActivePetId(ui: PersistedUIState, customPets: CustomPet[]): string {
  const id = ui.petId ?? ui.sidekickId
  if (typeof id !== 'string') {
    return DEFAULT_PET_ID
  }
  if (isBundledPetId(id) || customPets.some((pet) => pet.id === id)) {
    return id
  }
  return DEFAULT_PET_ID
}

/** Built-in pets first, then custom ones, with `active` resolved the way the renderer resolves it. */
export function describePetLibrary(ui: PersistedUIState): PetLibrary {
  const customPets = readCustomPets(ui)
  const activePetId = readActivePetId(ui, customPets)
  return {
    activePetId,
    visible: ui.petVisible ?? ui.sidekickVisible ?? true,
    pets: [
      ...BUNDLED_PET_IDS.map((id) => ({
        id,
        name: null,
        kind: 'built-in' as const,
        active: id === activePetId
      })),
      ...customPets.map((pet) => ({
        id: pet.id,
        name: pet.label,
        kind: pet.kind ?? ('image' as const),
        active: pet.id === activePetId
      }))
    ]
  }
}

/** Resolves a custom pet by id, then by exact (trimmed) name; duplicate names must be disambiguated by id. */
export function resolveCustomPet(customPets: CustomPet[], selector: string): CustomPet {
  const byId = customPets.find((pet) => pet.id === selector)
  if (byId) {
    return byId
  }
  const name = selector.trim()
  const byName = customPets.filter((pet) => pet.label === name)
  if (byName.length === 1) {
    return byName[0]
  }
  if (byName.length > 1) {
    throw new InvalidArgumentError(
      `More than one pet is named "${name}". Use its id instead: ${byName.map((pet) => pet.id).join(', ')}`
    )
  }
  if (isBundledPetId(selector)) {
    throw new InvalidArgumentError(`"${selector}" is a built-in pet and cannot be changed.`)
  }
  throw new InvalidArgumentError(`No custom pet matches "${selector}". Run \`orca pet list\`.`)
}

/** Built-in ids pass through as-is; any other selector must match a custom pet. */
export function resolveSelectablePetId(customPets: CustomPet[], selector: string): string {
  return isBundledPetId(selector) ? selector : resolveCustomPet(customPets, selector).id
}
