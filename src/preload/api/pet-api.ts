import type { CustomPet } from '../../shared/pet-types'

/** Bytes the renderer generated, plus the manifest describing them. Main pins
 *  the on-disk name, so no path crosses this boundary. */
export type GeneratedPetInput = {
  sheet: ArrayBuffer
  manifest: unknown
  label?: string
}

export type PetApi = {
  import: () => Promise<CustomPet | null>
  createGenerated: (input: GeneratedPetInput) => Promise<CustomPet>
  importPetBundle: () => Promise<CustomPet | null>
  read: (id: string, fileName: string, kind?: 'image' | 'bundle') => Promise<ArrayBuffer | null>
  delete: (id: string, fileName: string, kind?: 'image' | 'bundle') => Promise<void>
}
