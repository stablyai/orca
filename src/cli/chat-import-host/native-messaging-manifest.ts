export const NATIVE_MESSAGING_HOST_NAME = 'com.orca.chatimport'

export type NativeMessagingManifest = {
  name: string
  description: string
  path: string
  type: 'stdio'
  allowed_origins: string[]
}

export function buildNativeMessagingManifest(args: {
  launcherPath: string
  extensionId: string
}): NativeMessagingManifest {
  return {
    name: NATIVE_MESSAGING_HOST_NAME,
    description: 'Orca web chat import native messaging host',
    path: args.launcherPath,
    type: 'stdio',
    // Chrome requires a trailing slash on the extension origin.
    allowed_origins: [`chrome-extension://${args.extensionId}/`]
  }
}
