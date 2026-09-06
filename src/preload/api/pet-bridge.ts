import { ipcRenderer } from 'electron'
import type { CustomPet } from '../../shared/pet-types'
import type { PreloadApi } from '../api-types'

export const petApi = {
  import: (): Promise<CustomPet | null> => ipcRenderer.invoke('pet:import'),
  importPetBundle: (): Promise<CustomPet | null> => ipcRenderer.invoke('pet:importPetBundle'),
  read: (id: string, fileName: string, kind?: 'image' | 'bundle'): Promise<ArrayBuffer | null> =>
    ipcRenderer.invoke('pet:read', id, fileName, kind),
  delete: (id: string, fileName: string, kind?: 'image' | 'bundle'): Promise<void> =>
    ipcRenderer.invoke('pet:delete', id, fileName, kind)
} satisfies PreloadApi['pet']
