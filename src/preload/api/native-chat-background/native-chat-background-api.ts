export type NativeChatBackgroundImage = { bytes: ArrayBuffer; mimeType: string }

export type NativeChatBackgroundApi = {
  import: () => Promise<string | null>
  read: (fileName: string) => Promise<NativeChatBackgroundImage | null>
  delete: (fileName: string) => Promise<void>
}
