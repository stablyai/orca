export type OpenCodeWslRuntime = { distro: string } & (
  | { executable: string; readerPath: string; error?: never }
  | { error: string; executable?: never; readerPath?: never }
)
