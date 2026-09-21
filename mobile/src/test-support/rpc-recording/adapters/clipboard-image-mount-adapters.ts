import type { MountAdapter } from '../recording-scenario'
import { mountFixture } from '../recorder-fixture-shape'
import type { operationModuleLoader } from '../operation-module-loader'

const TERMINAL = 'terminal-1'
const DEVICE_TOKEN = 'device-token-1'
const CONNECTION = 'connection-1'
/** Four base64 characters per byte-triple; short enough that one chunk covers a whole upload. */
const IMAGE_BASE64 = 'AAAA'.repeat(8)

/**
 * The clipboard image path a phone takes to get pixels into a terminal: the chunked host upload and
 * its single-frame fallback, the picker-driven attachment that rides on it, and the native-chat
 * paste sequence. The picker itself is injected by the attachment's own dependency object, so no
 * image-picker module is reached; the recording observes the upload and the terminal writes.
 */
export function clipboardImageMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'clipboard.image-upload': ({ client }) => {
      const save = modules.load<typeof import('../../../session/mobile-clipboard-image')>(
        'mobile/src/session/mobile-clipboard-image.ts'
      ).saveMobileClipboardImageAsTempFile
      let path: unknown = 'unsaved'
      let failure: unknown = null
      return {
        action: (name, args) =>
          save(client, String(args.data ?? IMAGE_BASE64), {
            connectionId: name === 'local' ? null : CONNECTION
          }).then(
            (value: unknown) => {
              path = value
              return value
            },
            (error: unknown) => {
              failure = error instanceof Error ? error.message : String(error)
              throw error
            }
          ),
        state: () => ({ path, failure }),
        dispose: () => {}
      }
    },
    'clipboard.image-terminal-attachment': ({ client, effect }) => {
      const attach = modules.load<typeof import('../../../session/mobile-image-attachment')>(
        'mobile/src/session/mobile-image-attachment.ts'
      ).attachMobileImageToTerminal
      let attached: unknown = 'unattached'
      let failure: unknown = null
      return {
        action: (name) =>
          attach(
            'library',
            mountFixture<Parameters<typeof attach>[1]>({
              client,
              terminal: TERMINAL,
              deviceToken: name === 'anonymous' ? null : DEVICE_TOKEN,
              getConnectionId: () => Promise.resolve(CONNECTION),
              pickImage: () =>
                Promise.resolve(name === 'cancelled' ? null : { base64: IMAGE_BASE64 }),
              onUploadStart: () => effect('upload-start', {}),
              beforeTerminalSend: (terminal: string) => {
                effect('before-terminal-send', { terminal })
                return Promise.resolve(name !== 'blocked')
              }
            })
          ).then(
            (value: unknown) => {
              attached = value
              return value
            },
            (error: unknown) => {
              failure = error instanceof Error ? error.message : String(error)
              throw error
            }
          ),
        state: () => ({ attached, failure }),
        dispose: () => {}
      }
    },
    'nativeChat.image-upload': ({ client, effect }) => {
      const upload = modules.load<
        typeof import('../../../session/mobile-native-chat-image-attachment')
      >('mobile/src/session/mobile-native-chat-image-attachment.ts').uploadMobileNativeChatImages
      let uploaded: unknown = 'unuploaded'
      let failure: unknown = null
      return {
        action: (name) =>
          upload(
            'library',
            mountFixture<Parameters<typeof upload>[1]>({
              client,
              getConnectionId: () => Promise.resolve(CONNECTION),
              pickImages: () =>
                name === 'cancelled'
                  ? []
                  : name === 'two'
                    ? [{ base64: IMAGE_BASE64 }, { base64: IMAGE_BASE64, uri: 'file:///b.png' }]
                    : [{ base64: IMAGE_BASE64, uri: 'file:///a.png' }],
              onUploadStart: () => effect('upload-start', {}),
              onImageUploaded: (image) => effect('image-uploaded', image)
            })
          ).then(
            (value: unknown) => {
              uploaded = value
              return value
            },
            (error: unknown) => {
              failure = error instanceof Error ? error.message : String(error)
              throw error
            }
          ),
        state: () => ({ uploaded, failure }),
        dispose: () => {}
      }
    },
    'nativeChat.image-paste': ({ client }) => {
      const paste = modules.load<typeof import('../../../session/mobile-native-chat-image-send')>(
        'mobile/src/session/mobile-native-chat-image-send.ts'
      ).pasteMobileNativeChatImagePaths
      let pasted: unknown = 'unpasted'
      let failure: unknown = null
      return {
        action: (name) =>
          paste(
            mountFixture<Parameters<typeof paste>[0]>({
              client,
              terminal: TERMINAL,
              deviceToken: name === 'anonymous' ? null : DEVICE_TOKEN,
              imagePaths: name === 'two' ? ['/tmp/a.png', '/tmp/b.png'] : ['/tmp/a.png'],
              followedByText: name !== 'trailing',
              ...(name === 'burst' ? { clearInput: '' } : {})
            })
          ).then(
            (value: unknown) => {
              pasted = value
              return value
            },
            (error: unknown) => {
              failure = error instanceof Error ? error.message : String(error)
              throw error
            }
          ),
        state: () => ({ pasted, failure }),
        dispose: () => {}
      }
    }
  }
}
