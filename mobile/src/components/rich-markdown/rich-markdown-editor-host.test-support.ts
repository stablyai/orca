import type { RichMarkdownEditorHost } from './document-host-seams'

/** A page host that posts nowhere, cancels every prompt and measures no keyboard. */
export function quietRichMarkdownEditorHost(
  overrides: Partial<RichMarkdownEditorHost> = {}
): RichMarkdownEditorHost {
  return {
    postToHost: () => {},
    promptForUrl: async () => null,
    keyboardInsetSource: () => null,
    ...overrides
  }
}
