export type DetectionDirectoryRequest = {
  id: number
  dir: string
  inventory: boolean
  subdirectories: boolean
}

export type DetectionDirectoryListing = Map<string, string> | null | 'unverified'

export type DetectionDirectoryResponse = {
  id: number
  names: DetectionDirectoryListing
}
