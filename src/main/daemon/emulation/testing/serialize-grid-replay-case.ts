export type SerializeFuzzStep =
  | { kind: 'write'; data: string }
  | { kind: 'resize'; cols: number; rows: number }
  | { kind: 'check'; scrollback: number | undefined }

export type SerializeFuzzCase = {
  seed: number
  category: 'normal' | 'conpty'
  cols: number
  rows: number
  sourceScrollback: number
  steps: SerializeFuzzStep[]
}
