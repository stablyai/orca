export type AgentImageFitRequest = {
  id: number
  path: string
  outputDirectory: string
}

export type AgentImageFitResult = { path: string; bytes?: Uint8Array }

export type AgentImageFitResponse =
  | ({ id: number; ok: true } & AgentImageFitResult)
  | { id: number; ok: false; error: string }
