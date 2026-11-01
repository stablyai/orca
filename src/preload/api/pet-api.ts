import type { CustomPet } from '../../shared/pet-types'
import type { PetImportFailure } from '../../shared/pet-import-failure-copy'

export type PetApi = {
  import: () => Promise<CustomPet | PetImportFailure | null>
  importPetBundle: () => Promise<CustomPet | PetImportFailure | null>
  read: (id: string, fileName: string, kind?: 'image' | 'bundle') => Promise<ArrayBuffer | null>
  delete: (id: string, fileName: string, kind?: 'image' | 'bundle') => Promise<void>
}
