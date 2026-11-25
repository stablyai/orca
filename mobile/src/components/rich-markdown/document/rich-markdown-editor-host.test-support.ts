import type { RichMarkdownEditorHost } from './document-host-seams'

/** A page host that posts nowhere and cancels every prompt. */
export function quietRichMarkdownEditorHost(
  overrides: Partial<RichMarkdownEditorHost> = {}
): RichMarkdownEditorHost {
  return {
    postToHost: () => {},
    promptForUrl: async () => null,
    ...overrides
  }
}
