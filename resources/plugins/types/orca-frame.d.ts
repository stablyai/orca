// Author typings for `window.orca` in plugin panels and custom editors (`sandboxed-ui`).
// Mirrors src/shared/plugins/frames/plugin-panel-shell.ts (checked by plugin-frame-typings.test.ts).

declare module 'orca/frame' {
  import type { Disposable, HostApi, HostApiVersion } from 'orca/host'

  export type FrameTheme = { colorScheme: 'light' | 'dark' }
  /** `bytes` documents come from editors whose manifest sets `"contentKind": "bytes"`. */
  export type EditorContent = { kind: 'text'; text: string } | { kind: 'bytes'; bytes: ArrayBuffer }
  export type EditorDocument = {
    /** Rises with each document Orca sends, not with your own edits. */
    readonly version: number
    readonly readOnly: boolean
    readonly content: EditorContent
    /** Bytes documents: the manifest suffix that matched, e.g. `xlsx`. */
    readonly fileType?: string
  }
  /** The whole new content, made against document `baseVersion`. */
  export type EditorEdit = { baseVersion: number; content: EditorContent }
  /** Payloads of `orca.on(event, handler)`. */
  export type FrameEvents = {
    /** The `--orca-*` variables and the `light`/`dark` class on `<html>` already changed. */
    theme: FrameTheme
    /** Custom editors: a new document; `orca.document.onDidChange` is the usual way to listen. */
    'editor.document': EditorDocument
    /** Custom editors: post pending edits before a save; Orca waits for a returned promise. */
    'editor.flush': undefined
  }
  export type SaveAsOptions = {
    suggestedName?: string
    mimeType?: string
    data: string | ArrayBuffer | ArrayBufferView
  }
  export type EditorDocumentApi = {
    get(): Promise<EditorDocument>
    /** Replays the current document, then each one Orca sends when the file changes outside. */
    onDidChange(handler: (document: EditorDocument) => void): Disposable
    /** Rejects with `conflict`, `too_large` or `not_permitted` (read-only). */
    applyEdit(edit: EditorEdit): Promise<null>
  }
  export type OrcaFrameApi = {
    readonly api: HostApiVersion
    readonly host: HostApi<'panel' | 'editor'>
    on<E extends keyof FrameEvents>(
      event: E,
      handler: (payload: FrameEvents[E]) => unknown
    ): Disposable
    /** Orca's UI language as a BCP-47 tag. */
    readonly locale: string
    /** Desktop isolated frames only; needs a click or key press in the frame. */
    readonly shell?: { openExternal(url: string): Promise<{ opened: boolean }> }
    /** Desktop isolated frames only; `cancelled` when the person closes the dialog. */
    readonly files?: {
      saveAs(options: SaveAsOptions): Promise<{ status: 'saved' | 'cancelled' }>
    }
    /** Custom editors only. */
    readonly document?: EditorDocumentApi
  }

  global {
    /** Defined by Orca's frame shell before any plugin script runs; also `window.orca`. */
    var orca: OrcaFrameApi
  }
}
