// Author typings for `window.orca` in plugin panels and custom editors (`sandboxed-ui`).
// Mirrors src/shared/plugins/frames/plugin-panel-shell.ts (checked by plugin-frame-typings.test.ts).

declare module 'orca/frame' {
  import type {
    Disposable,
    HostApi,
    HostApiVersion,
    PluginBridgeApi,
    PluginEvents,
    SecretsApi,
    SettingsApi,
    StorageApi
  } from 'orca/host'

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
  /** Payloads of `orca.on(event, handler)`: frame events, and workspace and agent events (each
   *  needs the read capability of its domain: `workspace:read` or `agent:read`). */
  export type FrameEvents = PluginEvents & {
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
    /** Your plugin's own worker: `request` its handlers, hear what it `post`s. */
    readonly plugin: PluginBridgeApi
    /** The plugin's own storage, the same its worker uses (`storage:own`). */
    readonly storage: StorageApi
    /** The plugin's settings, declared ones with their defaults (`settings:own`). */
    readonly settings: SettingsApi
    /** The plugin's encrypted secrets (`secrets:own`). */
    readonly secrets: SecretsApi
    /** Desktop isolated frames only; needs a click or key press in the frame. */
    readonly shell?: {
      /** `reason`: the person cancelled, or Orca's window was hidden so nobody could confirm. */
      openExternal(
        url: string
      ): Promise<{ opened: boolean; reason?: 'cancelled' | 'consent-unavailable' }>
    }
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
