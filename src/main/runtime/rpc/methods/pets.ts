import { PetImportBundle, PetRename, PetSelector } from '../../../../shared/rpc-contract/pet-params'
import {
  DEFAULT_PET_ID,
  type CustomPet,
  type PetLibrary,
  type PetMutationResult
} from '../../../../shared/pet-types'
import { removePetFiles } from '../../../ipc/pet-file-removal'
import { getRuntimeDesktopSurface } from '../../runtime-desktop-surface'
import { defineMethod } from '../core'
import {
  describePetLibrary,
  readActivePetId,
  readCustomPets,
  resolveCustomPet,
  resolveSelectablePetId
} from './pet-library-state'

function summarizePet(pet: CustomPet): PetMutationResult['pet'] {
  return { id: pet.id, name: pet.label, kind: pet.kind ?? 'image' }
}

// Why UI state: the desktop renderer re-hydrates on every ui change, so the overlay updates live.
export const PET_METHODS = [
  defineMethod({
    name: 'pet.list',
    params: null,
    handler: (_params, { runtime }): PetLibrary => describePetLibrary(runtime.getUIState())
  }),
  defineMethod({
    name: 'pet.importBundle',
    params: PetImportBundle,
    handler: async (params, { runtime }): Promise<PetMutationResult> => {
      const importPetBundle = getRuntimeDesktopSurface().importPetBundle
      if (!importPetBundle) {
        throw new Error('Importing a pet needs the Orca desktop app.')
      }
      const imported = await importPetBundle(params.path)
      const pet = params.name ? { ...imported, label: params.name } : imported
      let customPets: CustomPet[]
      try {
        // Why read after the copy: the renderer may have changed customPets while the bundle was copying.
        customPets = readCustomPets(runtime.getUIState())
      } catch (error) {
        // Why only here: once updateUIState runs the pet may already be referenced, so its files must stay.
        await removePetFiles(imported.id, imported.fileName, imported.kind ?? 'bundle')
        throw error
      }
      // Why select + un-hide: matches the pet menu, where an imported pet becomes the visible one.
      const ui = runtime.updateUIState({
        customPets: [...customPets, pet],
        petId: pet.id,
        petVisible: true
      })
      return { pet: summarizePet(pet), library: describePetLibrary(ui) }
    }
  }),
  defineMethod({
    name: 'pet.select',
    params: PetSelector,
    handler: (params, { runtime }): PetLibrary => {
      const petId = resolveSelectablePetId(readCustomPets(runtime.getUIState()), params.pet)
      // Why petVisible: picking a pet in the menu also un-hides the overlay.
      return describePetLibrary(runtime.updateUIState({ petId, petVisible: true }))
    }
  }),
  defineMethod({
    name: 'pet.rename',
    params: PetRename,
    handler: (params, { runtime }): PetMutationResult => {
      const customPets = readCustomPets(runtime.getUIState())
      const target = resolveCustomPet(customPets, params.pet)
      const renamed = { ...target, label: params.name }
      const ui = runtime.updateUIState({
        customPets: customPets.map((pet) => (pet.id === target.id ? renamed : pet))
      })
      return { pet: summarizePet(renamed), library: describePetLibrary(ui) }
    }
  }),
  defineMethod({
    name: 'pet.remove',
    params: PetSelector,
    handler: async (params, { runtime }): Promise<PetMutationResult> => {
      const current = runtime.getUIState()
      const customPets = readCustomPets(current)
      const target = resolveCustomPet(customPets, params.pet)
      const wasActive = readActivePetId(current, customPets) === target.id
      // Why one update: customPets and petId must persist together, as the pet menu's remove does.
      const ui = runtime.updateUIState({
        customPets: customPets.filter((pet) => pet.id !== target.id),
        ...(wasActive ? { petId: DEFAULT_PET_ID } : {})
      })
      // Why after the update: a failed state write must not leave the list pointing at deleted files.
      try {
        await removePetFiles(target.id, target.fileName, target.kind ?? 'image', {
          throwOnError: true
        })
      } catch (error) {
        throw new Error(
          `Removed ${target.label} from the pet list, but could not delete its files: ${error instanceof Error ? error.message : String(error)}`
        )
      }
      return { pet: summarizePet(target), library: describePetLibrary(ui) }
    }
  })
]
