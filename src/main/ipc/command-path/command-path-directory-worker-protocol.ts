export type DetectionDirectoryRequest = { id: number; dir: string }

export type DetectionDirectoryResponse = {
  id: number
  names: Map<string, string> | null
}
