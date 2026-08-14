import type { CustomPet } from '../../shared/pet-types'

export type PetApi = {
  import: () => Promise<CustomPet | null>
  importPetBundle: () => Promise<CustomPet | null>
  read: (id: string, fileName: string, kind?: 'image' | 'bundle') => Promise<ArrayBuffer | null>
  delete: (id: string, fileName: string, kind?: 'image' | 'bundle') => Promise<void>
}
