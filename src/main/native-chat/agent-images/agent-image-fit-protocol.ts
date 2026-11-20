export type AgentImageFitRequest = {
  id: number
  path: string
  outputDirectory: string
  transientRoot?: string
}

export type AgentImageFitResponse =
  | { id: number; ok: true; path: string }
  | { id: number; ok: false; error: string }
