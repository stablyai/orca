import type { InstallDirectoryListing } from '../../../shared/shell/command-resolution/inventory-fs-probes'

export type DetectionDirectoryRequest = {
  id: number
  dir: string
  mode: 'path' | 'inventory' | 'install'
}

export type DetectionDirectoryListing = Map<string, string> | null
export type DirectoryWorkerListing = DetectionDirectoryListing | InstallDirectoryListing

export type DetectionDirectoryResponse = {
  id: number
  listing: DirectoryWorkerListing
}
