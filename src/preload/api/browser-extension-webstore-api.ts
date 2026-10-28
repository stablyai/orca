import type {
  BrowserExtensionInstallPromptRequest,
  BrowserExtensionInstallPromptResponse,
  BrowserExtensionWebStoreInstallResult
} from '../../shared/browser-extension-webstore'

/** window.api.browser members behind "Add from Chrome Web Store" and Orca's install prompt. */
export type BrowserExtensionWebStoreApi = {
  /** A store link or extension id; resolves after the user answers the prompt and the install ends. */
  extensionsInstallFromWebStore: (args: {
    profileId: string
    input: string
  }) => Promise<BrowserExtensionWebStoreInstallResult>
  onExtensionInstallPrompt: (
    callback: (request: BrowserExtensionInstallPromptRequest) => void
  ) => () => void
  onExtensionInstallPromptClosed: (callback: (event: { requestId: string }) => void) => () => void
  respondExtensionInstallPrompt: (
    response: BrowserExtensionInstallPromptResponse
  ) => Promise<boolean>
}
